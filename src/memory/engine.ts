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
  /**
   * Every mapping evicted by this access — the coordinator in
   * app/engines.ts swaps each to disk. Normally zero or one entry, but a
   * copy-on-write frame (roadmap-v5.md §1.3) is mapped by several address
   * spaces at once and evicting it invalidates all of them, so this is a
   * list rather than a single victim.
   */
  victims: { pid: number; page: number }[]
  /** Whether the page just installed had previously been swapped out — the coordinator uses this to know to swap it back in. */
  wasSwapped: boolean
  /**
   * Whether this exact (pid, page) mapping was already cached in the TLB
   * (roadmap-v4.md §2.2) — always false on a fault, since a page that just
   * faulted wasn't resident and therefore can't have had a legitimate
   * cached translation for it.
   */
  tlbHit: boolean
  /**
   * This access was a write to a copy-on-write page and therefore copied
   * the frame (roadmap-v5.md §1.3). Deliberately reported separately from
   * `fault`: a COW fault is a protection fault, resolved entirely in
   * memory with no disk involved, whereas `fault` here means "the page
   * wasn't resident". Folding the two together would inflate the fault
   * rate that drives the thrashing indicator, which is specifically about
   * paging pressure.
   */
  cowCopy: boolean
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
export const TLB_CAPACITY = 8

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
  /** Writes to a copy-on-write page that had to copy the frame — roadmap-v5.md §1.3. */
  private cowFaultCount = 0

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
    this.frames = Array.from({ length: config.frameCount }, (_, index) => ({ index, owner: null, shares: [] }))
    this.frameRefBit = Array(config.frameCount).fill(false)
    this.blocks = [{ id: `b${blockIdCounter++}`, start: 0, size: config.contiguousSizeMb, owner: null }]
  }

  /** Reserve frames 0..n for the "kernel" so the grid has a fixed, realistic-looking reserved region. */
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
   * Gives `childPid` a copy-on-write duplicate of `parentPid`'s address
   * space — roadmap-v5.md §1.3, the memory half of fork(). Every resident
   * page is *shared*, not copied: both tables point at the same frame,
   * both entries are marked `cow`, and the frame records the extra
   * mapping. Nothing is actually duplicated until somebody writes, which
   * is the whole point — `free` shows unchanged usage right after a fork
   * and only climbs once the two processes start diverging.
   *
   * A parent page that isn't resident (never touched, or swapped out) is
   * given to the child as a plain non-resident entry rather than sharing
   * the parent's swap slot: page files here are keyed by (pid, page) and
   * owned by the swap coordinator, so two processes pointing at one would
   * make cleanup ambiguous. The child simply faults its own copy in.
   * Returns false if the parent has no address space, or the child
   * already has one.
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

  /** How many frames are currently mapped by more than one address space — roadmap-v5.md §1.3. */
  getSharedFrameCount(): number {
    return this.frames.filter((f) => f.owner !== null && f.shares.length > 0).length
  }

  freeProcess(pid: number): number[] {
    const freed: number[] = []
    for (const frame of this.frames) {
      // A frame this process shares copy-on-write with somebody else
      // (roadmap-v5.md §1.3) must NOT be freed — the other side is still
      // reading it. Dropping this mapping and handing ownership over is
      // the whole job; only a frame with nothing left pointing at it
      // actually becomes free.
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
      return { fault: false, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false }
    }

    this.accessCount++
    const entry = table[page]!

    if (entry.valid && entry.frame !== null) {
      // A write to a copy-on-write page is the moment fork()'s shared
      // frame stops being shareable (roadmap-v5.md §1.3). Handled before
      // the ordinary-hit path below, because it isn't one: the mapping
      // has to move to a private frame first, which can itself require an
      // eviction.
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
      this.touchTlb(pid, page, freeFrame.index) // a page fault is never a TLB hit — see AccessResult.tlbHit's doc
      return { fault: true, victimFrame: null, victims: [], wasSwapped, tlbHit: false, cowCopy: false }
    }

    // Clock sweep: give every frame a second chance before evicting it.
    const victimIndex = this.selectVictimFrame()
    if (victimIndex === -1) {
      // Every frame is kernel-reserved: there is nowhere to put this page,
      // so it stays non-resident and the caller sees a fault it can't
      // service. Only reachable by reserving the whole frame table, but
      // reporting it beats spinning the sweep forever looking for a
      // victim that cannot exist.
      return { fault: true, victimFrame: null, victims: [], wasSwapped, tlbHit: false, cowCopy: false }
    }
    const victims = this.evictFrame(victimIndex)

    this.installPage(victimIndex, pid, entry, isWrite)
    this.touchTlb(pid, page, victimIndex) // a page fault is never a TLB hit — see AccessResult.tlbHit's doc
    this.clockHand = (victimIndex + 1) % this.frames.length
    return { fault: true, victimFrame: victimIndex, victims, wasSwapped, tlbHit: false, cowCopy: false }
  }

  /**
   * Invalidates every mapping of `frameIndex` and reports them, so the
   * coordinator can write each one out to swap. A copy-on-write frame
   * (roadmap-v5.md §1.3) is mapped by several address spaces at once, and
   * evicting it has to invalidate all of them — leaving a sharer's entry
   * pointing at a frame that now belongs to somebody else would let that
   * process read another's memory, which is the one thing paging exists
   * to prevent.
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
      // Eviction pushes the page out to disk (see the class doc — the
      // actual write happens one level up) rather than just discarding
      // it; the copy that comes back in later is read back from there.
      entry.modified = false
      entry.swapped = true
      // Each sharer faults its own private copy back in, so the sharing
      // ends here rather than being re-established on the way back.
      entry.cow = false
      this.swappedCount++
      // The evicted mapping no longer points at a frame it actually owns
      // — any cached TLB entry for it must go too, or a later access to
      // this exact (pid, page) could be misreported as a TLB hit for a
      // page that isn't even resident (found while implementing
      // roadmap-v4.md §2.2).
      this.invalidateTlb(mapping.pid, mapping.page)
      // The kernel-reserved frames are never chosen as a victim (see the
      // sweep above), so pid 0 can't appear here — but the swap
      // coordinator still shouldn't be handed one if that ever changes.
      if (mapping.pid !== 0) evicted.push({ ...mapping })
    }
    frame.shares = []
    return evicted
  }

  /**
   * The copy half of copy-on-write — roadmap-v5.md §1.3. The writer gets a
   * private frame holding its own copy; everyone else keeps the original.
   * If that leaves exactly one mapping on the original frame, its COW flag
   * is cleared too: a page nobody else can see any more doesn't need
   * protecting, and leaving the flag set would cost that process a
   * pointless second copy on its own next write.
   */
  private copyOnWrite(pid: number, page: number, entry: PageTableEntry): AccessResult {
    const sourceIndex = entry.frame!
    this.cowFaultCount++
    // Not counted as a page fault: nothing was paged in, and inflating
    // the fault rate would distort the thrashing indicator — see
    // AccessResult.cowCopy.
    this.recordFaultOutcome(false)

    this.detachMapping(sourceIndex, pid, page)

    // The copy needs a frame of its own, which may mean evicting one —
    // and the Clock sweep must not pick the very frame being copied from.
    const free = this.frames.find((f) => f.owner === null)
    let targetIndex: number
    let victims: { pid: number; page: number }[] = []
    if (free) {
      targetIndex = free.index
    } else {
      targetIndex = this.selectVictimFrame(sourceIndex)
      if (targetIndex === -1) {
        // Nowhere else to put the copy — the source frame is the only one
        // this engine may touch. Evicting it is still correct and still
        // terminates: detachMapping() above already took this writer's
        // mapping off the frame, so this pushes out the *other* sharers
        // and leaves the writer holding what is now genuinely its own
        // private copy. They fault their copies back in from swap.
        targetIndex = sourceIndex
      }
      victims = this.evictFrame(targetIndex)
      this.clockHand = (targetIndex + 1) % this.frames.length
    }

    entry.cow = false
    this.installPage(targetIndex, pid, entry, true)
    // The old translation pointed at the shared frame; this mapping lives
    // somewhere else now.
    this.invalidateTlb(pid, page)
    this.touchTlb(pid, page, targetIndex)
    return { fault: false, victimFrame: victims.length > 0 ? targetIndex : null, victims, wasSwapped: false, tlbHit: false, cowCopy: true }
  }

  /**
   * Removes one (pid, page) mapping from a frame it shares, promoting a
   * sharer to owner if the owner is the one leaving. Returns the mappings
   * still on the frame afterwards.
   */
  private detachMapping(frameIndex: number, pid: number, page: number): void {
    const frame = this.frames[frameIndex]!
    if (frame.owner?.pid === pid && frame.owner.page === page) {
      // The owner is leaving: someone still sharing the frame has to take
      // over as its owner, or the frame would read as free while other
      // page tables still point into it.
      frame.owner = frame.shares.shift() ?? null
      if (frame.owner === null) this.frameRefBit[frameIndex] = false
    } else {
      frame.shares = frame.shares.filter((m) => !(m.pid === pid && m.page === page))
    }
    this.clearCowIfUnshared(frameIndex)
  }

  /** A frame down to a single mapping has nobody left to protect the page from — see copyOnWrite(). */
  private clearCowIfUnshared(frameIndex: number): void {
    const frame = this.frames[frameIndex]!
    if (frame.shares.length > 0 || !frame.owner) return
    const entry = this.pageTables.get(frame.owner.pid)?.[frame.owner.page]
    if (entry) entry.cow = false
  }

  /**
   * One Clock sweep, returning the frame to evict, or -1 if this engine
   * holds no frame it is allowed to take. `exclude` is never chosen —
   * copyOnWrite() needs a destination that isn't the frame it is copying
   * *from*, which the sweep would otherwise be free to pick.
   *
   * The sweep is bounded at two full passes: one to clear reference bits,
   * a second to find the frame that first pass demoted. An unbounded
   * `while (true)` reads fine while *some* frame is always eligible, but
   * spins forever the moment none is — reachable with `exclude` on a
   * two-frame engine whose other frame is kernel-reserved, and reachable
   * even without it if every frame were reserved. Returning -1 makes that
   * the caller's decision rather than a hang.
   */
  private selectVictimFrame(exclude?: number): number {
    let index = this.clockHand
    for (let step = 0; step < this.frames.length * 2; step++) {
      const candidate = this.frames[index]!
      // Kernel-reserved frames (owner.pid === 0) are permanently exempt —
      // nothing ever re-references them to keep their bit alive, so
      // without this they'd eventually be swept up and evicted like any
      // cold frame.
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
      cowFaults: this.cowFaultCount,
      sharedFrames: this.getSharedFrameCount(),
      thrashing: this.isThrashing(),
      recentFaultRate: this.getRecentFaultRate(),
    }
  }
}
