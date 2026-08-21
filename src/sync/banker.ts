// Banker's Algorithm — deadlock *avoidance* (roadmap-v3.md §3.1), extending
// the sync module's existing deadlock *detection* (deadlock.ts) rather than
// replacing it — the same "here's the problem, here's a different way to
// defend against it" narrative as crash -> fsck and race condition ->
// mutex, not a second, competing option for the same mechanism (ADR-0001).
// Detection catches a deadlock after the fact via a wait-for-graph cycle
// check; avoidance never lets the system enter an unsafe state to begin
// with, by running the safety algorithm before granting any request.
//
// The scenario matrices below are Silberschatz's own canonical worked
// example (5 processes, 3 resource types) — chosen deliberately, the same
// way the scheduler/memory engines are tested against hand-traced
// textbook references, so every number here is independently verifiable
// against the book rather than made up for this demo.

export const RESOURCE_NAMES = ['A', 'B', 'C'] as const
export const PROCESS_COUNT = 5
const RESOURCE_COUNT = RESOURCE_NAMES.length

const INITIAL_ALLOCATION: readonly (readonly number[])[] = [
  [0, 1, 0],
  [2, 0, 0],
  [3, 0, 2],
  [2, 1, 1],
  [0, 0, 2],
]

const MAX: readonly (readonly number[])[] = [
  [7, 5, 3],
  [3, 2, 2],
  [9, 0, 2],
  [2, 2, 2],
  [4, 3, 3],
]

const INITIAL_AVAILABLE: readonly number[] = [3, 3, 2]

export type RequestDenialReason = 'exceeds-need' | 'insufficient-available' | 'unsafe'

export type RequestResult =
  | { ok: true; safeSequence: number[] }
  | { ok: false; reason: RequestDenialReason }

export interface BankerLogEntry {
  id: number
  text: string
  kind: 'granted' | 'denied' | 'info'
}

function vecLteAll(a: readonly number[], b: readonly number[]): boolean {
  return a.every((v, i) => v <= b[i]!)
}

function vecAdd(a: readonly number[], b: readonly number[]): number[] {
  return a.map((v, i) => v + b[i]!)
}

function vecSub(a: readonly number[], b: readonly number[]): number[] {
  return a.map((v, i) => v - b[i]!)
}

/**
 * The safety algorithm (Silberschatz 8.6.3): can every process finish, in
 * SOME order, given the resources it could still eventually get back from
 * others finishing first? Simulates the best case — each process that
 * *can* currently have its remaining need satisfied runs to completion and
 * releases everything it held — and keeps repeating until either every
 * process has finished (safe; the discovery order is a valid safe
 * sequence) or nothing can progress anymore (unsafe).
 */
function findSafeSequence(
  allocation: readonly (readonly number[])[],
  need: readonly (readonly number[])[],
  available: readonly number[],
): { safe: boolean; sequence: number[] } {
  const n = allocation.length
  const work = [...available]
  const finished = Array<boolean>(n).fill(false)
  const sequence: number[] = []

  let madeProgress = true
  while (madeProgress && sequence.length < n) {
    madeProgress = false
    for (let p = 0; p < n; p++) {
      if (finished[p]) continue
      if (vecLteAll(need[p]!, work)) {
        for (let r = 0; r < work.length; r++) work[r] = work[r]! + allocation[p]![r]!
        finished[p] = true
        sequence.push(p)
        madeProgress = true
      }
    }
  }

  return { safe: sequence.length === n, sequence }
}

const LOG_LIMIT = 30

export class BankerEngine {
  private allocation: number[][] = INITIAL_ALLOCATION.map((row) => [...row])
  private available: number[] = [...INITIAL_AVAILABLE]
  private log: BankerLogEntry[] = []
  private nextLogId = 1

  private pushLog(text: string, kind: BankerLogEntry['kind']): void {
    this.log.push({ id: this.nextLogId++, text, kind })
    if (this.log.length > LOG_LIMIT) this.log.shift()
  }

  getAllocation(): number[][] {
    return this.allocation.map((row) => [...row])
  }

  getMax(): number[][] {
    return MAX.map((row) => [...row])
  }

  getNeed(): number[][] {
    return MAX.map((row, p) => vecSub(row, this.allocation[p]!))
  }

  getAvailable(): number[] {
    return [...this.available]
  }

  getLog(): BankerLogEntry[] {
    return this.log
  }

  /** Is the CURRENT (already-granted) state safe, and if so, in what order could everyone finish? Recomputed fresh each call — there's no cached "safe" flag to go stale. */
  checkCurrentSafety(): { safe: boolean; sequence: number[] } {
    return findSafeSequence(this.allocation, this.getNeed(), this.available)
  }

  /**
   * Requests `req` (one count per resource type, same order as
   * RESOURCE_NAMES) on behalf of process `pid`. Denies immediately if it
   * exceeds that process's declared max-need or the currently available
   * pool (no point running the safety check for a request that's invalid
   * on its face); otherwise tentatively grants it and runs the safety
   * algorithm — if the resulting state is unsafe, the grant is rolled
   * back and denied. This IS the avoidance mechanism: unlike the sync
   * module's semaphore (which only ever checks "is a slot free right
   * now"), this looks ahead at whether granting could strand the system.
   */
  request(pid: number, req: readonly number[]): RequestResult {
    if (pid < 0 || pid >= PROCESS_COUNT || req.length !== RESOURCE_COUNT) {
      throw new Error(`BankerEngine.request: invalid pid ${pid} or request length ${req.length}`)
    }

    const need = this.getNeed()[pid]!
    if (!vecLteAll(req, need)) {
      this.pushLog(`P${pid} request [${req.join(',')}] exceeds its declared need [${need.join(',')}] — denied`, 'denied')
      return { ok: false, reason: 'exceeds-need' }
    }
    if (!vecLteAll(req, this.available)) {
      this.pushLog(`P${pid} request [${req.join(',')}] exceeds available [${this.available.join(',')}] — denied`, 'denied')
      return { ok: false, reason: 'insufficient-available' }
    }

    const trialAvailable = vecSub(this.available, req)
    const trialAllocation = this.allocation.map((row, p) => (p === pid ? vecAdd(row, req) : row))
    const trialNeed = MAX.map((row, p) => vecSub(row, trialAllocation[p]!))

    const { safe, sequence } = findSafeSequence(trialAllocation, trialNeed, trialAvailable)
    if (!safe) {
      this.pushLog(`P${pid} request [${req.join(',')}] would leave an unsafe state — denied (rolled back)`, 'denied')
      return { ok: false, reason: 'unsafe' }
    }

    this.available = trialAvailable
    this.allocation = trialAllocation
    this.pushLog(
      `P${pid} request [${req.join(',')}] granted — safe sequence <${sequence.map((p) => `P${p}`).join(', ')}>`,
      'granted',
    )
    return { ok: true, safeSequence: sequence }
  }

  reset(): void {
    this.allocation = INITIAL_ALLOCATION.map((row) => [...row])
    this.available = [...INITIAL_AVAILABLE]
    this.log = []
  }
}
