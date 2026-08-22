// I/O (disk) scheduling — roadmap-v4.md §1.1. The filesystem engine already
// models a block device (DiskBlock[]); this models the *order* in which
// pending block accesses actually reach the head. Per ADR-0009 (and the
// same "one justified mechanism" precedent as ADR-0001's MLFQ), the
// algorithm is SCAN (the elevator algorithm) — the head sweeps end to end
// across the cylinders, servicing every pending request it passes over,
// and only reverses direction at the two ends of the disk. No FCFS/
// C-SCAN/SSTF picker exists alongside it.

export type IoKind = 'read' | 'write'

export interface IoRequest {
  id: number
  /** Cylinder == block index on this simulator's disk (0..cylinderCount-1). */
  blockIndex: number
  kind: IoKind
  enqueuedTick: number
  /**
   * Process blocked waiting for this request to complete — roadmap-v5.md
   * §1.1. Undefined for the filesystem's own bookkeeping I/O (block
   * allocation, swap writes): those are real head movement, but nobody is
   * sitting in WAITING until they finish.
   */
  waiterPid?: number
}

export interface CompletedIoRequest extends IoRequest {
  completedTick: number
}

/** How many recently-completed requests the UI can show as "just serviced". */
const COMPLETED_HISTORY_LIMIT = 8

export interface IoSchedulerState {
  pending: IoRequest[]
  headPosition: number
  direction: 1 | -1
  recentlyCompleted: CompletedIoRequest[]
}

export interface IoSchedulerMetrics {
  cylinderCount: number
  /** How many cylinders the head crosses per tick — see IoScheduler's constructor. */
  seekCylindersPerTick: number
  headPosition: number
  direction: 1 | -1
  pendingCount: number
  completedCount: number
  /** Total cylinders the head has moved while actually servicing the queue (see step()'s idle guard below) — the textbook "total head movement" figure SCAN is judged by. */
  totalSeekDistance: number
  avgSeekDistance: number
  avgWaitTicks: number
}

/**
 * SCAN disk-head scheduler over `cylinderCount` cylinders (one per disk
 * block). `enqueue()` is called by FilesystemEngine whenever an operation
 * physically touches a block; `step()` is called once per fs tick and
 * advances the head by exactly one cylinder, servicing anything it lands
 * on.
 */
export class IoScheduler {
  private pending: IoRequest[] = []
  private completed: CompletedIoRequest[] = []
  private nextRequestId = 1
  private headPosition = 0
  private direction: 1 | -1 = 1
  private completedCount = 0
  private totalSeekDistance = 0
  private totalWaitTicks = 0

  /**
   * `seekCylindersPerTick` is how far the head travels per simulated tick.
   * It defaults to 1 (one cylinder per tick — the plain model every unit
   * test in ioScheduler.test.ts is hand-traced against), but the live
   * filesystem runs it faster (see DEFAULT_FS_CONFIG). That knob only
   * became load-bearing once processes actually *block* on their requests
   * (roadmap-v5.md §1.1): at one cylinder per tick a 64-cylinder disk makes
   * the average request wait ~32 ticks, which is an order of magnitude
   * longer than the CPU bursts around it and would leave the whole
   * simulation visibly stalled in WAITING. It changes only how fast the
   * sweep runs — never its order, which is what SCAN is actually about.
   */
  constructor(
    private cylinderCount: number,
    private seekCylindersPerTick = 1,
  ) {}

  /** Queues a request. Returns false (and queues nothing) for a cylinder this disk doesn't have. */
  enqueue(blockIndex: number, kind: IoKind, tick: number, waiterPid?: number): boolean {
    if (blockIndex < 0 || blockIndex >= this.cylinderCount) return false // out of range — nothing sensible to schedule
    this.pending.push({ id: this.nextRequestId++, blockIndex, kind, enqueuedTick: tick, waiterPid })
    return true
  }

  /**
   * Advances the head by one cylinder and services whatever it lands on.
   * An idle disk (nothing pending) parks instead of sweeping for no
   * reason — a real head doesn't rack back and forth with nothing to
   * read/write, and parking keeps `totalSeekDistance` meaningful as "how
   * far the head moved in service of the queue" rather than being
   * inflated by aimless idle motion. When work arrives again the head
   * resumes from wherever it parked, in whatever direction it was already
   * sweeping — exactly like a real SCAN sweep that got caught up.
   *
   * Returns everything it serviced this tick, so a caller that has
   * processes blocked on those requests (app/engines.ts, roadmap-v5.md
   * §1.1) can wake them without having to poll the completed history and
   * diff it.
   */
  step(currentTick: number): CompletedIoRequest[] {
    const serviced: CompletedIoRequest[] = []
    // One tick can carry the head across several cylinders (see the
    // constructor). Repeating the exact single-cylinder sweep below is
    // deliberate over computing a range: reversal at the two ends, the
    // 1-cylinder-disk special case and the idle park all keep working
    // unchanged, and the head can even turn around mid-tick.
    for (let i = 0; i < this.seekCylindersPerTick; i++) {
      serviced.push(...this.stepOneCylinder(currentTick))
    }
    if (this.completed.length > COMPLETED_HISTORY_LIMIT) {
      this.completed.splice(0, this.completed.length - COMPLETED_HISTORY_LIMIT)
    }
    return serviced
  }

  private stepOneCylinder(currentTick: number): CompletedIoRequest[] {
    if (this.pending.length === 0) return []

    // A 1-cylinder disk has nowhere to sweep to — cylinder 0 is
    // simultaneously "both ends", so the two branches below would
    // otherwise fire in sequence and walk the head onto the nonexistent
    // cylinder 1 before bouncing back (found by code review). Every
    // request already sits under the head; just service it in place.
    if (this.cylinderCount > 1) {
      if (this.headPosition <= 0) this.direction = 1
      else if (this.headPosition >= this.cylinderCount - 1) this.direction = -1

      this.headPosition += this.direction
      this.totalSeekDistance += 1
    }

    const [serviced, stillPending] = partition(this.pending, (r) => r.blockIndex === this.headPosition)
    this.pending = stillPending
    const completedNow: CompletedIoRequest[] = []
    for (const req of serviced) {
      this.completedCount++
      this.totalWaitTicks += currentTick - req.enqueuedTick
      const done = { ...req, completedTick: currentTick }
      this.completed.push(done)
      completedNow.push(done)
    }
    return completedNow
  }

  getState(): IoSchedulerState {
    return {
      pending: [...this.pending],
      headPosition: this.headPosition,
      direction: this.direction,
      recentlyCompleted: [...this.completed],
    }
  }

  getMetrics(): IoSchedulerMetrics {
    return {
      cylinderCount: this.cylinderCount,
      seekCylindersPerTick: this.seekCylindersPerTick,
      headPosition: this.headPosition,
      direction: this.direction,
      pendingCount: this.pending.length,
      completedCount: this.completedCount,
      totalSeekDistance: this.totalSeekDistance,
      avgSeekDistance: this.completedCount === 0 ? 0 : this.totalSeekDistance / this.completedCount,
      avgWaitTicks: this.completedCount === 0 ? 0 : this.totalWaitTicks / this.completedCount,
    }
  }

  /**
   * Wipes the queue and every metric. Returns the pids that were still
   * blocked on a now-discarded request: dropping the queue silently would
   * leave those processes WAITING on a wakeup that can never arrive, and
   * the caller (app/engines.ts) is the only place that can actually
   * release them — see roadmap-v5.md §1.1.
   */
  reset(): number[] {
    const abandoned = this.pending.flatMap((r) => (r.waiterPid === undefined ? [] : [r.waiterPid]))
    this.pending = []
    this.completed = []
    this.nextRequestId = 1
    this.headPosition = 0
    this.direction = 1
    this.completedCount = 0
    this.totalSeekDistance = 0
    this.totalWaitTicks = 0
    return abandoned
  }
}

function partition<T>(items: T[], predicate: (item: T) => boolean): [T[], T[]] {
  const yes: T[] = []
  const no: T[] = []
  for (const item of items) (predicate(item) ? yes : no).push(item)
  return [yes, no]
}
