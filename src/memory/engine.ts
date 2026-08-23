import type { ContiguousBlock, Frame, PageTableEntry } from '../shared/types'

export interface MemoryConfig {
  frameCount: number
  contiguousSizeMb: number
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  frameCount: 24,
  contiguousSizeMb: 256,
}

export interface AccessResult {
  fault: boolean
  victimFrame: number | null
  victims: { pid: number; page: number }[]
  wasSwapped: boolean
  tlbHit: boolean
  cowCopy: boolean
}

let blockIdCounter = 1

interface TlbEntry {
  pid: number
  page: number
  frame: number
}

export const TLB_CAPACITY = 8

const THRASHING_WINDOW = 20
const THRASHING_FAULT_RATE_THRESHOLD = 0.7

function tlbKey(pid: number, page: number): string {
  return `${pid}:${page}`
}

/**
 * Demand-paged memory using Clock (Second-Chance) replacement, with an
 * 8-entry TLB in front of the page table and copy-on-write sharing after
 * fork(). A First-Fit contiguous allocator runs alongside purely as a
 * historical reference visualisation — it does not back the paging path.
 *
 * Tracks only *that* an evicted page is swapped; writing the page file is
 * the coordinator's job in app/engines.ts, so this stays filesystem-free.
 */
export class MemoryEngine {
  private frames: Frame[]
  private frameRefBit: boolean[]
  private clockHand = 0
  private pageTables = new Map<number, PageTableEntry[]>()
  private blocks: ContiguousBlock[]

  private pageFaultCount = 0
  private accessCount = 0
  private swappedCount = 0
  private cowFaultCount = 0

  private tlb = new Map<string, TlbEntry>()
  private tlbAccessCount = 0
  private tlbHitCount = 0

  private recentFaultWindow: boolean[] = []

  constructor(config: MemoryConfig = DEFAULT_MEMORY_CONFIG) {
    this.frames = Array.from({ length: config.frameCount }, (_, index) => ({ index, owner: null, shares: [] }))
    this.frameRefBit = Array(config.frameCount).fill(false)
    this.blocks = [{ id: `b${blockIdCounter++}`, start: 0, size: config.contiguousSizeMb, owner: null }]
  }

  reserveKernelFrames(count: number): void {
    for (let i = 0; i < count && i < this.frames.length; i++) {
      this.frames[i] = { index: i, owner: { pid: 0, page: 0 }, shares: [] }
      this.frameRefBit[i] = true
    }
    this.clockHand = count % this.frames.length
  }

  allocateProcess(pid: number, pageCount: number): void {
    if (this.pageTables.has(pid)) {
      throw new Error(`MemoryEngine.allocateProcess: pid ${pid} is already allocated`)
    }
    const table: PageTableEntry[] = Array.from({ length: pageCount }, (_, page) => ({
      page,
      frame: null,
      valid: false,
      referenced: false,
      modified: false,
      swapped: false,
      cow: false,
    }))
    this.pageTables.set(pid, table)

    const size = Math.min(80, Math.max(10, pageCount * 10))
    this.firstFitAllocate(pid, size)
  }

  /**
   * Copy-on-write duplicate of an address space. Resident pages are shared,
   * not copied — nothing is duplicated until somebody writes. A page that
   * isn't resident is given to the child as a plain empty entry rather than
   * sharing the parent's swap slot, which is keyed by pid.
   */
  forkAddressSpace(parentPid: number, childPid: number): boolean {
    const parentTable = this.pageTables.get(parentPid)
    if (!parentTable || this.pageTables.has(childPid)) return false

    const childTable: PageTableEntry[] = parentTable.map((parentEntry) => {
      const resident = parentEntry.valid && parentEntry.frame !== null
      if (!resident) {
        return { page: parentEntry.page, frame: null, valid: false, referenced: false, modified: false, swapped: false, cow: false }
      }
      parentEntry.cow = true
      this.frames[parentEntry.frame!]!.shares.push({ pid: childPid, page: parentEntry.page })
      return {
        page: parentEntry.page,
        frame: parentEntry.frame,
        valid: true,
        referenced: false,
        modified: false,
        swapped: false,
        cow: true,
      }
    })

    this.pageTables.set(childPid, childTable)
    const size = Math.min(80, Math.max(10, childTable.length * 10))
    this.firstFitAllocate(childPid, size)
    return true
  }

  getSharedFrameCount(): number {
    return this.frames.filter((f) => f.owner !== null && f.shares.length > 0).length
  }

  /** Drops this pid's mappings, promoting a sharer to owner rather than freeing a frame someone still reads. */
  freeProcess(pid: number): number[] {
    const freed: number[] = []
    for (const frame of this.frames) {
      const ownsIt = frame.owner?.pid === pid
      const sharesIt = frame.shares.some((m) => m.pid === pid)
      if (!ownsIt && !sharesIt) continue

      if (ownsIt) {
        frame.owner = frame.shares.shift() ?? null
        frame.shares = frame.shares.filter((m) => m.pid !== pid)
      } else {
        frame.shares = frame.shares.filter((m) => m.pid !== pid)
      }

      if (frame.owner === null) {
        freed.push(frame.index)
        this.frameRefBit[frame.index] = false
      } else {
        this.clearCowIfUnshared(frame.index)
      }
    }
    this.swappedCount -= this.getSwappedPages(pid).length
    this.pageTables.delete(pid)
    this.freeContiguous(pid)
    for (const [key, entry] of this.tlb) {
      if (entry.pid === pid) this.tlb.delete(key)
    }
    return freed
  }

  private touchTlb(pid: number, page: number, frame: number): boolean {
    const key = tlbKey(pid, page)
    const hit = this.tlb.has(key)
    this.tlb.delete(key)
    this.tlb.set(key, { pid, page, frame })
    if (this.tlb.size > TLB_CAPACITY) {
      this.tlb.delete(this.tlb.keys().next().value!)
    }
    this.tlbAccessCount++
    if (hit) this.tlbHitCount++
    return hit
  }

  private invalidateTlb(pid: number, page: number): void {
    this.tlb.delete(tlbKey(pid, page))
  }

  private recordFaultOutcome(faulted: boolean): void {
    this.recentFaultWindow.push(faulted)
    if (this.recentFaultWindow.length > THRASHING_WINDOW) this.recentFaultWindow.shift()
  }

  access(pid: number, page: number, isWrite = false): AccessResult {
    const table = this.pageTables.get(pid)
    if (!table || page < 0 || page >= table.length) {
      return { fault: false, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false }
    }

    this.accessCount++
    const entry = table[page]!

    if (entry.valid && entry.frame !== null) {
      if (isWrite && entry.cow) return this.copyOnWrite(pid, page, entry)

      entry.referenced = true
      this.frameRefBit[entry.frame] = true
      if (isWrite) entry.modified = true
      const tlbHit = this.touchTlb(pid, page, entry.frame)
      this.recordFaultOutcome(false)
      return { fault: false, victimFrame: null, victims: [], wasSwapped: false, tlbHit, cowCopy: false }
    }

    this.pageFaultCount++
    this.recordFaultOutcome(true)
    const wasSwapped = entry.swapped
    if (wasSwapped) this.swappedCount--

    const freeFrame = this.frames.find((f) => f.owner === null)
    if (freeFrame) {
      this.installPage(freeFrame.index, pid, entry, isWrite)
      this.touchTlb(pid, page, freeFrame.index)
      return { fault: true, victimFrame: null, victims: [], wasSwapped, tlbHit: false, cowCopy: false }
    }

    const victimIndex = this.selectVictimFrame()
    if (victimIndex === -1) {
      return { fault: true, victimFrame: null, victims: [], wasSwapped, tlbHit: false, cowCopy: false }
    }
    const victims = this.evictFrame(victimIndex)

    this.installPage(victimIndex, pid, entry, isWrite)
    this.touchTlb(pid, page, victimIndex)
    this.clockHand = (victimIndex + 1) % this.frames.length
    return { fault: true, victimFrame: victimIndex, victims, wasSwapped, tlbHit: false, cowCopy: false }
  }

  /**
   * Invalidates every mapping of a frame, not just the owner's — a shared
   * frame is mapped by several address spaces, and leaving a stale mapping
   * behind is one process reading another's memory.
   */
  private evictFrame(frameIndex: number): { pid: number; page: number }[] {
    const frame = this.frames[frameIndex]!
    const mappings = [...(frame.owner ? [frame.owner] : []), ...frame.shares]
    const evicted: { pid: number; page: number }[] = []

    for (const mapping of mappings) {
      const entry = this.pageTables.get(mapping.pid)?.[mapping.page]
      if (!entry) continue
      entry.valid = false
      entry.frame = null
      entry.referenced = false
      entry.modified = false
      entry.swapped = true
      entry.cow = false
      this.swappedCount++
      this.invalidateTlb(mapping.pid, mapping.page)
      if (mapping.pid !== 0) evicted.push({ ...mapping })
    }
    frame.shares = []
    return evicted
  }

  /**
   * The copy half of copy-on-write. The writer gets a private frame; the
   * rest keep the original. If that leaves a single mapping its COW flag is
   * cleared too, or that process would pay a second, pointless copy.
   */
  private copyOnWrite(pid: number, page: number, entry: PageTableEntry): AccessResult {
    const sourceIndex = entry.frame!
    this.cowFaultCount++
    this.recordFaultOutcome(false)

    this.detachMapping(sourceIndex, pid, page)

    const free = this.frames.find((f) => f.owner === null)
    let targetIndex: number
    let victims: { pid: number; page: number }[] = []
    if (free) {
      targetIndex = free.index
    } else {
      targetIndex = this.selectVictimFrame(sourceIndex)
      if (targetIndex === -1) {
        targetIndex = sourceIndex
      }
      victims = this.evictFrame(targetIndex)
      this.clockHand = (targetIndex + 1) % this.frames.length
    }

    entry.cow = false
    this.installPage(targetIndex, pid, entry, true)
    this.invalidateTlb(pid, page)
    this.touchTlb(pid, page, targetIndex)
    return { fault: false, victimFrame: victims.length > 0 ? targetIndex : null, victims, wasSwapped: false, tlbHit: false, cowCopy: true }
  }

  private detachMapping(frameIndex: number, pid: number, page: number): void {
    const frame = this.frames[frameIndex]!
    if (frame.owner?.pid === pid && frame.owner.page === page) {
      frame.owner = frame.shares.shift() ?? null
      if (frame.owner === null) this.frameRefBit[frameIndex] = false
    } else {
      frame.shares = frame.shares.filter((m) => !(m.pid === pid && m.page === page))
    }
    this.clearCowIfUnshared(frameIndex)
  }

  private clearCowIfUnshared(frameIndex: number): void {
    const frame = this.frames[frameIndex]!
    if (frame.shares.length > 0 || !frame.owner) return
    const entry = this.pageTables.get(frame.owner.pid)?.[frame.owner.page]
    if (entry) entry.cow = false
  }

  /**
   * One Clock sweep, or -1 if no frame may be taken. Bounded at two passes
   * (one to clear reference bits, one to find what it demoted): with
   * `exclude` set there may be no eligible frame at all, and an unbounded
   * sweep would spin.
   */
  private selectVictimFrame(exclude?: number): number {
    let index = this.clockHand
    for (let step = 0; step < this.frames.length * 2; step++) {
      const candidate = this.frames[index]!
      if (candidate.owner?.pid === 0 || index === exclude) {
        index = (index + 1) % this.frames.length
        continue
      }
      if (!this.frameRefBit[index]) return index
      this.frameRefBit[index] = false
      index = (index + 1) % this.frames.length
    }
    return -1
  }

  private installPage(frameIndex: number, pid: number, entry: PageTableEntry, isWrite: boolean): void {
    this.frames[frameIndex]!.owner = { pid, page: entry.page }
    this.frames[frameIndex]!.shares = []
    this.frameRefBit[frameIndex] = true
    entry.valid = true
    entry.frame = frameIndex
    entry.referenced = true
    entry.modified = isWrite
    entry.swapped = false
  }

  getSwappedPages(pid: number): number[] {
    const table = this.pageTables.get(pid)
    if (!table) return []
    return table.filter((e) => e.swapped).map((e) => e.page)
  }

  private firstFitAllocate(pid: number, size: number): void {
    const index = this.blocks.findIndex((b) => b.owner === null && b.size >= size)
    if (index === -1) return

    const block = this.blocks[index]!
    const allocated: ContiguousBlock = { id: `b${blockIdCounter++}`, start: block.start, size, owner: pid }
    const remainder = block.size - size
    const next: ContiguousBlock[] = [allocated]
    if (remainder > 0) {
      next.push({ id: `b${blockIdCounter++}`, start: block.start + size, size: remainder, owner: null })
    }
    this.blocks.splice(index, 1, ...next)
  }

  private freeContiguous(pid: number): void {
    const block = this.blocks.find((b) => b.owner === pid)
    if (!block) return
    block.owner = null
    this.coalesce()
  }

  private coalesce(): void {
    this.blocks.sort((a, b) => a.start - b.start)
    const merged: ContiguousBlock[] = []
    for (const block of this.blocks) {
      const prev = merged[merged.length - 1]
      if (prev && prev.owner === null && block.owner === null) {
        prev.size += block.size
      } else {
        merged.push({ ...block })
      }
    }
    this.blocks = merged
  }

  getFrames(): Frame[] {
    return this.frames
  }

  getClockHand(): number {
    return this.clockHand
  }

  getPageTable(pid: number): PageTableEntry[] | undefined {
    return this.pageTables.get(pid)
  }

  getContiguousBlocks(): ContiguousBlock[] {
    return this.blocks
  }

  getTlbEntries(): TlbEntry[] {
    return [...this.tlb.values()]
  }

  getRecentFaultRate(): number {
    if (this.recentFaultWindow.length === 0) return 0
    return this.recentFaultWindow.filter(Boolean).length / this.recentFaultWindow.length
  }

  isThrashing(): boolean {
    return this.recentFaultWindow.length >= THRASHING_WINDOW && this.getRecentFaultRate() >= THRASHING_FAULT_RATE_THRESHOLD
  }

  getMetrics() {
    const freeBlocks = this.blocks.filter((b) => b.owner === null)
    const totalFree = freeBlocks.reduce((sum, b) => sum + b.size, 0)
    const largestFree = freeBlocks.reduce((max, b) => Math.max(max, b.size), 0)
    const externalFragmentation = totalFree > 0 ? 1 - largestFree / totalFree : 0
    return {
      pageFaults: this.pageFaultCount,
      accesses: this.accessCount,
      hitRatio: this.accessCount > 0 ? 1 - this.pageFaultCount / this.accessCount : 0,
      externalFragmentation,
      swappedPages: this.swappedCount,
      tlbHitRatio: this.tlbAccessCount > 0 ? this.tlbHitCount / this.tlbAccessCount : 0,
      cowFaults: this.cowFaultCount,
      sharedFrames: this.getSharedFrameCount(),
      thrashing: this.isThrashing(),
      recentFaultRate: this.getRecentFaultRate(),
    }
  }
}
