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
}

let blockIdCounter = 1

/**
 * Demand-paged memory manager using Clock (Second-Chance) replacement —
 * the cheap, hardware-realistic approximation of LRU that real kernels
 * actually run, since exact LRU needs reference tracking hardware doesn't
 * cheaply provide. Runs a separate, independent First-Fit contiguous
 * allocator alongside it purely as a historical reference visualisation
 * (see plan.md §2.2) — it does not back the paging path at all.
 */
export class MemoryEngine {
  private frames: Frame[]
  private frameRefBit: boolean[]
  private clockHand = 0
  private pageTables = new Map<number, PageTableEntry[]>()
  private blocks: ContiguousBlock[]

  private pageFaultCount = 0
  private accessCount = 0

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
    this.pageTables.delete(pid)
    this.freeContiguous(pid)
    return freed
  }

  /** Simulate one memory reference by `pid` to a page in its own address space. */
  access(pid: number, page: number, isWrite = false): AccessResult {
    const table = this.pageTables.get(pid)
    if (!table || page < 0 || page >= table.length) return { fault: false, victimFrame: null }

    this.accessCount++
    const entry = table[page]!

    if (entry.valid && entry.frame !== null) {
      entry.referenced = true
      this.frameRefBit[entry.frame] = true
      if (isWrite) entry.modified = true
      return { fault: false, victimFrame: null }
    }

    this.pageFaultCount++
    const freeFrame = this.frames.find((f) => f.owner === null)
    if (freeFrame) {
      this.installPage(freeFrame.index, pid, entry, isWrite)
      return { fault: true, victimFrame: null }
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
        // Eviction implies writing the dirty page back to its backing
        // store — the copy that comes back in from there later starts
        // clean again, exactly like a fresh page would.
        victimEntry.modified = false
      }
    }

    this.installPage(victimIndex, pid, entry, isWrite)
    this.clockHand = (victimIndex + 1) % this.frames.length
    return { fault: true, victimFrame: victimIndex }
  }

  private installPage(frameIndex: number, pid: number, entry: PageTableEntry, isWrite: boolean): void {
    this.frames[frameIndex]!.owner = { pid, page: entry.page }
    this.frameRefBit[frameIndex] = true
    entry.valid = true
    entry.frame = frameIndex
    entry.referenced = true
    entry.modified = isWrite
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
    }
  }
}
