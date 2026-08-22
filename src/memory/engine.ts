import type { ContiguousBlock, Frame, PageTableEntry } from '../shared/types'

export interface MemoryConfig {
  frameCount: number
  /** Total size of the simulated contiguous address space, in MB. */
  contiguousSizeMb: number
}

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  frameCount: 24,
  contiguousSizeMb: 256,
}

export interface AccessResult {
  fault: boolean
  /** Frame that had to be evicted to service the fault, or null on a free-frame fill / a hit. */
  victimFrame: number | null
  /** Whose page got evicted this access, if any — the coordinator in app/engines.ts uses this to swap it to disk. */
  victim: { pid: number; page: number } | null
  /** Whether the page just installed had previously been swapped out — the coordinator uses this to know to swap it back in. */
  wasSwapped: boolean
  /**
   * Whether this exact (pid, page) mapping was already cached in the TLB
   * (roadmap-v4.md §2.2) — always false on a fault, since a page that just
   * faulted wasn't resident and therefore can't have had a legitimate
   * cached translation for it.
   */
  tlbHit: boolean
}

let blockIdCounter = 1

/** A translation-lookaside-buffer entry — one cached (pid, page) -> frame mapping. */
interface TlbEntry {
  pid: number
  page: number
  frame: number
}

/**
 * Real TLBs hold tens to low thousands of entries, far fewer than the
 * frame table — small on purpose, so its hit rate actually demonstrates
 * *why* it helps despite the indirection (roadmap-v4.md §2.2), rather than
 * just mirroring the page table 1:1.
 */
const TLB_CAPACITY = 8

/** Sliding window of the most recent accesses' fault/hit outcomes, used by isThrashing() below. */
const THRASHING_WINDOW = 20
/**
 * Fraction of the last THRASHING_WINDOW accesses that were faults, above
 * which the system is considered to be thrashing — Silberschatz's own
 * informal definition (fault rate high enough that the system spends more
 * time paging than running processes), not a working-set-size formula:
 * this simulator only ever services one access per tick from whichever
 * single process is RUNNING (see app/engines.ts's stepSimulation()), so a
 * recent-fault-rate window is the simplest honest proxy for "thrashing" a
 * uniprocessor step function like this one can actually exhibit.
 */
const THRASHING_FAULT_RATE_THRESHOLD = 0.7

function tlbKey(pid: number, page: number): string {
  return `${pid}:${page}`
}

/**
 * Demand-paged memory manager using Clock (Second-Chance) replacement —
 * the cheap, hardware-realistic approximation of LRU that real kernels
 * actually run, since exact LRU needs reference tracking hardware doesn't
 * cheaply provide. Runs a separate, independent First-Fit contiguous
 * allocator alongside it purely as a historical reference visualisation
 * (see plan.md §2.2) — it does not back the paging path at all.
 *
 * This engine only tracks *that* an evicted page is "swapped" (roadmap.md
 * §2.1) via `PageTableEntry.swapped` and reports victim/wasSwapped info
 * back from access() — it deliberately does NOT import FilesystemEngine
 * to actually write/read the page file. That coordination lives one level
 * up, in app/engines.ts, so memory and filesystem stay decoupled and pure
 * (see the ADR-0004 "engines as singletons" reasoning: neither engine
 * should know the other exists).
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

  // TLB (roadmap-v4.md §2.2) — a Map so an existing key can be
  // delete()+set() back in to move it to the most-recently-used end;
  // iteration order then gives eviction (oldest = tlb.keys().next()) for
  // free, no separate LRU bookkeeping structure needed.
  private tlb = new Map<string, TlbEntry>()
  private tlbAccessCount = 0
  private tlbHitCount = 0

  // Thrashing indicator (roadmap-v4.md §2.2) — see THRASHING_WINDOW/
  // THRESHOLD above for what this actually measures.
  private recentFaultWindow: boolean[] = []

  constructor(config: MemoryConfig = DEFAULT_MEMORY_CONFIG) {
    this.frames = Array.from({ length: config.frameCount }, (_, index) => ({ index, owner: null }))
    this.frameRefBit = Array(config.frameCount).fill(false)
    this.blocks = [{ id: `b${blockIdCounter++}`, start: 0, size: config.contiguousSizeMb, owner: null }]
  }

  /** Reserve frames 0..n for the "kernel" so the grid has a fixed, realistic-looking reserved region. */
  reserveKernelFrames(count: number): void {
    for (let i = 0; i < count && i < this.frames.length; i++) {
      this.frames[i] = { index: i, owner: { pid: 0, page: 0 } }
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
    }))
    this.pageTables.set(pid, table)

    const size = Math.min(80, Math.max(10, pageCount * 10))
    this.firstFitAllocate(pid, size)
  }

  freeProcess(pid: number): number[] {
    const freed: number[] = []
    for (const frame of this.frames) {
      if (frame.owner?.pid === pid) {
        freed.push(frame.index)
        frame.owner = null
        this.frameRefBit[frame.index] = false
      }
    }
    // Any pages still swapped out never come back through installPage()'s
    // decrement, so reconcile the counter here before the table (and with
    // it, the only record of which pages were swapped) disappears. The
    // coordinator in app/engines.ts reads getSwappedPages(pid) *before*
    // calling this, so it can still clean up their page files on disk.
    this.swappedCount -= this.getSwappedPages(pid).length
    this.pageTables.delete(pid)
    this.freeContiguous(pid)
    for (const [key, entry] of this.tlb) {
      if (entry.pid === pid) this.tlb.delete(key)
    }
    return freed
  }

  /** Records a real TLB lookup, moving a hit to the MRU end or inserting a fresh entry (LRU-evicting the oldest if full) either way. Returns whether it was a hit. */
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

  /** A page just left the page table (evicted, or its process freed) — any cached translation for it is now a dangling pointer into someone else's frame. */
  private invalidateTlb(pid: number, page: number): void {
    this.tlb.delete(tlbKey(pid, page))
  }

  private recordFaultOutcome(faulted: boolean): void {
    this.recentFaultWindow.push(faulted)
    if (this.recentFaultWindow.length > THRASHING_WINDOW) this.recentFaultWindow.shift()
  }

  /** Simulate one memory reference by `pid` to a page in its own address space. */
  access(pid: number, page: number, isWrite = false): AccessResult {
    const table = this.pageTables.get(pid)
    if (!table || page < 0 || page >= table.length) {
      return { fault: false, victimFrame: null, victim: null, wasSwapped: false, tlbHit: false }
    }

    this.accessCount++
    const entry = table[page]!

    if (entry.valid && entry.frame !== null) {
      entry.referenced = true
      this.frameRefBit[entry.frame] = true
      if (isWrite) entry.modified = true
      const tlbHit = this.touchTlb(pid, page, entry.frame)
      this.recordFaultOutcome(false)
      return { fault: false, victimFrame: null, victim: null, wasSwapped: false, tlbHit }
    }

    this.pageFaultCount++
    this.recordFaultOutcome(true)
    const wasSwapped = entry.swapped
    if (wasSwapped) this.swappedCount--

    const freeFrame = this.frames.find((f) => f.owner === null)
    if (freeFrame) {
      this.installPage(freeFrame.index, pid, entry, isWrite)
      this.touchTlb(pid, page, freeFrame.index) // a page fault is never a TLB hit — see AccessResult.tlbHit's doc
      return { fault: true, victimFrame: null, victim: null, wasSwapped, tlbHit: false }
    }

    // Clock sweep: give every frame a second chance before evicting it.
    // Kernel-reserved frames (owner.pid === 0) are permanently exempt —
    // nothing ever re-references them to keep their bit alive, so without
    // this they'd eventually be swept up and evicted like any cold frame.
    let victimIndex = this.clockHand
    while (true) {
      const candidate = this.frames[victimIndex]!
      if (candidate.owner?.pid === 0) {
        victimIndex = (victimIndex + 1) % this.frames.length
        continue
      }
      if (!this.frameRefBit[victimIndex]) break
      this.frameRefBit[victimIndex] = false
      victimIndex = (victimIndex + 1) % this.frames.length
    }
    const victim = this.frames[victimIndex]!
    const victimOwner = victim.owner
    if (victimOwner) {
      const victimTable = this.pageTables.get(victimOwner.pid)
      const victimEntry = victimTable?.[victimOwner.page]
      if (victimEntry) {
        victimEntry.valid = false
        victimEntry.frame = null
        victimEntry.referenced = false
        // Eviction pushes the page out to disk (see the class doc — the
        // actual write happens one level up) rather than just discarding
        // it; the copy that comes back in later is read back from there.
        victimEntry.modified = false
        victimEntry.swapped = true
        this.swappedCount++
        // The evicted mapping no longer points at a frame it actually
        // owns — any cached TLB entry for it must go too, or a later
        // access to this exact (pid, page) could be misreported as a TLB
        // hit for a page that isn't even resident (found while
        // implementing roadmap-v4.md §2.2).
        this.invalidateTlb(victimOwner.pid, victimOwner.page)
      }
    }

    this.installPage(victimIndex, pid, entry, isWrite)
    this.touchTlb(pid, page, victimIndex) // a page fault is never a TLB hit — see AccessResult.tlbHit's doc
    this.clockHand = (victimIndex + 1) % this.frames.length
    return {
      fault: true,
      victimFrame: victimIndex,
      victim: victimOwner && victimOwner.pid !== 0 ? { pid: victimOwner.pid, page: victimOwner.page } : null,
      wasSwapped,
      tlbHit: false,
    }
  }

  private installPage(frameIndex: number, pid: number, entry: PageTableEntry, isWrite: boolean): void {
    this.frames[frameIndex]!.owner = { pid, page: entry.page }
    this.frameRefBit[frameIndex] = true
    entry.valid = true
    entry.frame = frameIndex
    entry.referenced = true
    entry.modified = isWrite
    entry.swapped = false
  }

  /** Pages of `pid` currently swapped out — used to clean up their page files when the process exits. */
  getSwappedPages(pid: number): number[] {
    const table = this.pageTables.get(pid)
    if (!table) return []
    return table.filter((e) => e.swapped).map((e) => e.page)
  }

  private firstFitAllocate(pid: number, size: number): void {
    const index = this.blocks.findIndex((b) => b.owner === null && b.size >= size)
    if (index === -1) return // demo allocator: silently skip if the arena is full

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

  /** Current TLB contents, oldest (next to be evicted) first — roadmap-v4.md §2.2. */
  getTlbEntries(): TlbEntry[] {
    return [...this.tlb.values()]
  }

  /**
   * Fraction of the last (up to) THRASHING_WINDOW accesses that faulted.
   * Not meaningful until the window has actually filled — returns 0 before
   * that, same as an idle system's true fault rate.
   */
  getRecentFaultRate(): number {
    if (this.recentFaultWindow.length === 0) return 0
    return this.recentFaultWindow.filter(Boolean).length / this.recentFaultWindow.length
  }

  /** See THRASHING_FAULT_RATE_THRESHOLD's doc for what this actually measures and why. */
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
      thrashing: this.isThrashing(),
      recentFaultRate: this.getRecentFaultRate(),
    }
  }
}
