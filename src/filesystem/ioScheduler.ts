export type IoKind = 'read' | 'write'

export interface IoRequest {
  id: number
  blockIndex: number
  kind: IoKind
  enqueuedTick: number
  waiterPid?: number
}

export interface CompletedIoRequest extends IoRequest {
  completedTick: number
}

const COMPLETED_HISTORY_LIMIT = 8

export interface IoSchedulerState {
  pending: IoRequest[]
  headPosition: number
  direction: 1 | -1
  recentlyCompleted: CompletedIoRequest[]
}

export interface IoSchedulerMetrics {
  cylinderCount: number
  seekCylindersPerTick: number
  headPosition: number
  direction: 1 | -1
  pendingCount: number
  completedCount: number
  totalSeekDistance: number
  avgSeekDistance: number
  avgWaitTicks: number
}

/**
 * SCAN (elevator) disk-head scheduling. The head sweeps end to end,
 * servicing every request it passes over and reversing only at the two
 * ends. An idle disk parks rather than sweeping for nothing, which keeps
 * totalSeekDistance meaningful as "distance travelled in service of the
 * queue".
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

  constructor(
    private cylinderCount: number,
    private seekCylindersPerTick = 1,
  ) {}

  enqueue(blockIndex: number, kind: IoKind, tick: number, waiterPid?: number): boolean {
    if (blockIndex < 0 || blockIndex >= this.cylinderCount) return false
    this.pending.push({ id: this.nextRequestId++, blockIndex, kind, enqueuedTick: tick, waiterPid })
    return true
  }

  /** Advances the head and returns what it serviced, so blocked waiters can be released. */
  step(currentTick: number): CompletedIoRequest[] {
    const serviced: CompletedIoRequest[] = []
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

  /** Returns pids left blocked on a discarded request — they must be released or they wait forever. */
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
