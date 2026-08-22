import { INIT_PID, type BlockReason, type GanttSample, type Process, type ProcessKind, type QueueLevel } from '../shared/types'
import { simBus } from '../shared/eventBus'

export interface SchedulerConfig {
  /** Time slice per queue level, in ticks. Q2 is Infinity → plain FCFS. */
  quanta: readonly [number, number, number]
  /** Every N ticks, every non-terminated process is boosted back to Q0 to prevent starvation. 0 disables it. */
  boostInterval: number
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  quanta: [4, 8, Infinity],
  boostInterval: 50,
}

export interface TickResult {
  tick: number
  sample: GanttSample
  boosted: boolean
}

let pidCounter = 1
export function nextPid(): number {
  return pidCounter++
}

/** Reset the pid counter — test-only helper so suites don't depend on run order. */
export function resetPidCounter(start = 1): void {
  pidCounter = start
}

/**
 * Alternating CPU/IO burst sequence, always starting and ending on a CPU
 * burst (Silberschatz's burst-cycle model). Interactive processes get many
 * short bursts with frequent I/O; CPU-bound processes get few long bursts.
 */
export function generateBursts(kind: ProcessKind): number[] {
  const bursts: number[] = []
  if (kind === 'interactive') {
    const cycles = 2 + Math.floor(Math.random() * 3) // 2..4 CPU bursts
    for (let i = 0; i < cycles; i++) {
      bursts.push(2 + Math.floor(Math.random() * 4)) // CPU 2..5
      if (i < cycles - 1) bursts.push(3 + Math.floor(Math.random() * 6)) // IO 3..8
    }
  } else {
    const cycles = 1 + Math.floor(Math.random() * 2) // 1..2 CPU bursts
    for (let i = 0; i < cycles; i++) {
      bursts.push(8 + Math.floor(Math.random() * 13)) // CPU 8..20
      if (i < cycles - 1) bursts.push(1 + Math.floor(Math.random() * 3)) // IO 1..3
    }
  }
  return bursts
}

export interface CreateProcessOptions {
  /** Defaults to this process's own pid (a normal process owns its own address space) — pass the group leader's pid for a thread, roadmap-v4.md §2.1. */
  memoryOwnerPid?: number
  /** Defaults to a fresh random page count. A thread must instead pass its group's single shared value, so every thread's random memory access in app/engines.ts's stepSimulation() lands inside the one address space they all actually share. */
  pageCount?: number
}

export function createProcess(
  name: string,
  kind: ProcessKind,
  bursts = generateBursts(kind),
  parentPid: number = INIT_PID,
  opts: CreateProcessOptions = {},
): Process {
  const pid = nextPid()
  return {
    pid,
    name,
    kind,
    state: 'NEW',
    queueLevel: 0,
    parentPid,
    memoryOwnerPid: opts.memoryOwnerPid ?? pid,
    arrivalTick: 0,
    finishTick: null,
    bursts,
    burstIndex: 0,
    burstRemaining: bursts[0] ?? 0,
    sliceRemaining: DEFAULT_SCHEDULER_CONFIG.quanta[0],
    blockedOn: null,
    totalWaitingTicks: 0,
    totalBurstTicks: 0,
    contextSwitches: 0,
    pageCount: opts.pageCount ?? 2 + Math.floor(Math.random() * 5),
  }
}

/**
 * The seam between the scheduler and a real I/O device — roadmap-v5.md
 * §1.1. Before this existed, an "I/O burst" was a number the scheduler
 * counted down by itself, so a process's I/O had no relationship to the
 * disk the filesystem module was simultaneously modelling: `cat` never
 * blocked anything, and a process in WAITING never moved the disk head.
 *
 * This keeps SchedulerEngine dependency-free (plan.md §5) — it knows only
 * that *something* may take ownership of a wait, not what a disk, a
 * cylinder or SCAN are. app/engines.ts installs the real implementation,
 * exactly like it already coordinates swap between memory and filesystem
 * (ADR-0004).
 */
export interface IoPort {
  /**
   * Called when a process's CPU burst ends and its next burst is an I/O
   * one. Return true to take ownership of the wait — the process then
   * stays WAITING until wake() is called for it. Return false to decline
   * (e.g. the device is unavailable), and the scheduler falls back to the
   * original self-timed countdown so a process can never be lost.
   *
   * `sizeHint` is the generated I/O burst length. A real device decides
   * its own service time (here: how far the head has to travel), so this
   * is genuinely only a hint about how much work was asked for.
   */
  submit(pid: number, sizeHint: number): boolean
}

/** How many TERMINATED processes to keep around (for the process list / getProcesses()) before pruning the oldest. */
const MAX_TERMINATED_HISTORY = 15

/**
 * Pure, dependency-free Multi-Level Feedback Queue scheduler.
 *
 * Rules (OSTEP-style):
 *  1. Higher queue (lower index) always preempts a lower one.
 *  2. Equal-priority processes round-robin using that level's quantum.
 *  3. A process that blocks for I/O before its slice expires keeps its
 *     queue level when it comes back — voluntary yielding isn't punished.
 *  4. A process that burns its whole slice without blocking is demoted
 *     one level.
 *  5. Every `boostInterval` ticks, every process is reset to Q0 so a
 *     long-running batch job can't starve forever.
 */
export class SchedulerEngine {
  private processes = new Map<number, Process>()
  private queues: [number[], number[], number[]] = [[], [], []]
  /**
   * Every WAITING process, whatever it's waiting for. Only the ones with
   * `blockedOn === 'io-burst'` are counted down by tick(); the rest are
   * owned by whoever blocked them and only leave via wake().
   */
  private waiting = new Set<number>()
  private ioPort: IoPort | null = null
  private pendingArrivals: number[] = []
  private tickCount = 0
  private lastBoostTick = 0
  private lastRunningPid: number | null = null
  private globalContextSwitches = 0
  private busyTicks = 0

  // Lifetime aggregates survive pruning even after the Process object
  // itself is dropped from `processes` — see recordTermination().
  private terminatedHistory: number[] = []
  private terminatedCount = 0
  private terminatedWaitingTicks = 0
  private terminatedTurnaroundTicks = 0

  constructor(private config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG) {}

  /**
   * Single choke point for every state transition into TERMINATED —
   * kill(), the RUNNING winner's natural-completion branch, and the I/O
   * resolution step's malformed-bursts guard each call this exactly once
   * per process, which is what lets `process:terminated` be emitted here
   * (rather than inferred by polling for it afterwards) and keeps
   * `processes` bounded (old dead processes are pruned; their stats live
   * on in the running totals below so getMetrics() stays accurate).
   */
  private recordTermination(process: Process, reason: 'natural' | 'killed'): void {
    this.terminatedCount++
    this.terminatedWaitingTicks += process.totalWaitingTicks
    this.terminatedTurnaroundTicks += process.finishTick! - process.arrivalTick

    this.terminatedHistory.push(process.pid)
    if (this.terminatedHistory.length > MAX_TERMINATED_HISTORY) {
      this.processes.delete(this.terminatedHistory.shift()!)
    }

    simBus.emit('process:terminated', {
      pid: process.pid,
      name: process.name,
      reason,
      memoryOwnerPid: process.memoryOwnerPid,
    })
  }

  get currentTick(): number {
    return this.tickCount
  }

  spawn(process: Process): Process {
    process.arrivalTick = this.tickCount
    this.processes.set(process.pid, process)
    this.pendingArrivals.push(process.pid)
    return process
  }

  kill(pid: number): Process | undefined {
    const process = this.processes.get(pid)
    if (!process || process.state === 'TERMINATED') return undefined

    this.queues[process.queueLevel] = this.queues[process.queueLevel].filter((p) => p !== pid)
    this.waiting.delete(pid)
    this.pendingArrivals = this.pendingArrivals.filter((p) => p !== pid)

    process.state = 'TERMINATED'
    process.blockedOn = null
    process.finishTick = this.tickCount
    this.recordTermination(process, 'killed')
    return process
  }

  /**
   * SIGSTOP (roadmap-v3.md §2.2) — pauses a process without killing it.
   * Pulls it out of whichever bookkeeping structure currently tracks it
   * (ready queue, the I/O-waiting set, or pendingArrivals for a process
   * stopped in the single tick before it would have first been admitted)
   * so `tick()` simply never looks at it again until cont() re-admits it —
   * no burst consumed, no waiting time accrued, exactly like the process
   * doesn't exist for scheduling purposes while stopped.
   */
  stop(pid: number): Process | undefined {
    const process = this.processes.get(pid)
    if (!process || process.state === 'TERMINATED') return undefined
    if (process.state === 'STOPPED') return process // idempotent — signalling an already-stopped process is harmless

    this.queues[process.queueLevel] = this.queues[process.queueLevel].filter((p) => p !== pid)
    this.waiting.delete(pid)
    this.pendingArrivals = this.pendingArrivals.filter((p) => p !== pid)
    // `blockedOn` is deliberately left as-is: a process stopped while
    // blocked is still blocked, and cont() below uses that to put it back
    // where it was rather than jumping it to READY (roadmap-v5.md §1.1).
    process.state = 'STOPPED'
    return process
  }

  /**
   * SIGCONT — resumes a stopped process at its last queue level, never
   * demoting it for having been stopped. Where it resumes *to* depends on
   * whether it was blocked when the SIGSTOP landed:
   *  - Stopped while runnable (RUNNING, or READY): back to READY, keeping
   *    whatever sliceRemaining/burstRemaining it already had. Not a fresh
   *    quantum — an earlier version reset sliceRemaining here, which let
   *    repeated SIGSTOP/SIGCONT grant an unlimited string of fresh quanta
   *    at Q0 and defeat MLFQ demotion entirely (found by code review).
   *  - Stopped while blocked (WAITING, `blockedOn !== null`): back to
   *    WAITING, still blocked on the same thing. This replaces the old
   *    "instantly complete the I/O burst" simplification, which inferred
   *    the wait from `burstIndex % 2` — a heuristic that only ever worked
   *    while a self-timed I/O burst was the single possible reason to
   *    wait. It can't survive roadmap-v5.md §1.1/§1.2, where a process can
   *    just as well be parked on a real disk request or a pipe, so the
   *    reason is now recorded (Process.blockedOn) instead of guessed, and
   *    resuming simply puts the process back where it was. A device wake
   *    that arrives *while* it's stopped isn't lost either — wake() clears
   *    blockedOn without readying it, so this lands in the runnable branch
   *    above.
   */
  cont(pid: number): Process | undefined {
    const process = this.processes.get(pid)
    if (!process || process.state === 'TERMINATED') return undefined
    if (process.state !== 'STOPPED') return process // idempotent — signalling a process that isn't stopped is harmless

    if (process.blockedOn !== null) {
      process.state = 'WAITING'
      this.waiting.add(pid)
      return process
    }
    process.state = 'READY'
    this.queues[process.queueLevel].push(pid)
    return process
  }

  /**
   * Installs (or clears, with null) the device that owns I/O waits — see
   * IoPort. Nothing calls this in a plain unit test, which is exactly why
   * the self-timed fallback still exists: SchedulerEngine on its own is
   * still a complete, hand-traceable MLFQ implementation.
   */
  setIoPort(port: IoPort | null): void {
    this.ioPort = port
  }

  /**
   * Blocks a runnable process on something outside the scheduler — a pipe
   * that's full/empty (roadmap-v5.md §1.2), never an I/O burst (those go
   * through tick()'s own burst-completion path). The process keeps its
   * queue level and its remaining burst: it is parked, not punished, the
   * same Rule-3 treatment a voluntary I/O yield gets.
   *
   * Returns false for a process that isn't currently runnable — already
   * blocked, stopped, terminated or not admitted yet. Blocking a
   * not-yet-admitted process would strand it: tick()'s admission step
   * would ready it again a tick later while it's still in `waiting`,
   * leaving it in two structures at once.
   */
  blockOn(pid: number, reason: Exclude<BlockReason, 'io-burst'>): boolean {
    const process = this.processes.get(pid)
    if (!process) return false
    if (process.state !== 'RUNNING' && process.state !== 'READY') return false

    this.queues[process.queueLevel] = this.queues[process.queueLevel].filter((p) => p !== pid)
    process.state = 'WAITING'
    process.blockedOn = reason
    this.waiting.add(pid)
    return true
  }

  /**
   * The "interrupt": whatever owned this process's wait is telling the
   * scheduler it's finished — roadmap-v5.md §1.1. Returns false when
   * there was no externally-owned wait to end (unknown pid, terminated,
   * runnable already, or waiting on a self-timed `io-burst` the scheduler
   * resolves itself).
   *
   * A wake for a STOPPED process is honoured but doesn't ready it — the
   * device really has finished, so `blockedOn` is cleared and the burst
   * advanced, but SIGSTOP still means stopped until a SIGCONT arrives.
   * Dropping the wake instead would leave that process permanently
   * blocked on a request nobody will ever complete a second time.
   *
   * `reason` must match what the process is actually blocked on. Callers
   * always know which wait they are ending, and requiring the match is
   * what stops one subsystem from resolving another's: a pipe reader
   * telling the scheduler "the writer produced something" must not
   * accidentally complete an unrelated disk request the counterpart
   * happens to be parked on — which, since a device wake advances the
   * process past its I/O burst, would silently corrupt its burst sequence.
   */
  wake(pid: number, reason: Exclude<BlockReason, 'io-burst'>): boolean {
    const process = this.processes.get(pid)
    if (!process || process.state === 'TERMINATED') return false
    if (process.blockedOn !== reason) return false

    process.blockedOn = null
    this.waiting.delete(pid)
    // A device wait stands in for the I/O burst the process was on, so
    // returning from it advances past that burst exactly like the
    // self-timed path in tick() does.
    if (reason === 'device' && this.advancePastIoBurst(process)) return true
    if (process.state === 'STOPPED') return true

    process.state = 'READY'
    // Rule 3: no demotion on return from I/O — same queue level as before.
    process.sliceRemaining = this.config.quanta[process.queueLevel]
    this.queues[process.queueLevel].push(pid)
    return true
  }

  /**
   * Moves a process off the I/O burst it was serving and onto the next CPU
   * burst. Returns true if that terminated it instead — see the long note
   * in tick()'s I/O resolution step for why a run off the end of `bursts`
   * terminates rather than scheduling a phantom CPU tick.
   */
  private advancePastIoBurst(process: Process): boolean {
    process.burstIndex++
    if (process.burstIndex >= process.bursts.length) {
      process.state = 'TERMINATED'
      process.blockedOn = null
      process.finishTick = this.tickCount
      this.recordTermination(process, 'natural')
      return true
    }
    process.burstRemaining = process.bursts[process.burstIndex]!
    return false
  }

  /** How many processes are blocked for each reason — surfaced by `ps`/`top` and the scheduler window. */
  getBlockedCounts(): Record<BlockReason, number> {
    const counts: Record<BlockReason, number> = { 'io-burst': 0, device: 0, pipe: 0 }
    for (const pid of this.waiting) {
      const reason = this.processes.get(pid)?.blockedOn
      if (reason) counts[reason]++
    }
    return counts
  }

  getProcess(pid: number): Process | undefined {
    return this.processes.get(pid)
  }

  getProcesses(): Process[] {
    return [...this.processes.values()]
  }

  getReadyQueues(): [Process[], Process[], Process[]] {
    return [
      this.queues[0].map((pid) => this.processes.get(pid)!).filter(Boolean),
      this.queues[1].map((pid) => this.processes.get(pid)!).filter(Boolean),
      this.queues[2].map((pid) => this.processes.get(pid)!).filter(Boolean),
    ]
  }

  getRunning(): Process | undefined {
    return this.getProcesses().find((p) => p.state === 'RUNNING')
  }

  getMetrics() {
    const n = this.terminatedCount
    return {
      completed: n,
      avgWaitingTicks: n ? this.terminatedWaitingTicks / n : 0,
      avgTurnaroundTicks: n ? this.terminatedTurnaroundTicks / n : 0,
      contextSwitches: this.globalContextSwitches,
      cpuUtilization: this.tickCount ? this.busyTicks / this.tickCount : 0,
    }
  }

  /** Advance the simulation by exactly one tick. */
  tick(): TickResult {
    this.tickCount++

    // 1. Admit anything that arrived since the last tick, always at Q0.
    for (const pid of this.pendingArrivals) {
      const process = this.processes.get(pid)
      if (!process) continue
      process.state = 'READY'
      process.queueLevel = 0
      process.sliceRemaining = this.config.quanta[0]
      this.queues[0].push(pid)
    }
    this.pendingArrivals = []

    // 2. Resolve I/O completions — only for the self-timed waits this
    //    engine owns. A process parked on a real device or a pipe
    //    (roadmap-v5.md §1.1/§1.2) is deliberately untouched here: nothing
    //    counts down, and it leaves this set only when wake() says the
    //    thing it's actually waiting for has happened.
    for (const pid of [...this.waiting]) {
      const process = this.processes.get(pid)
      if (!process) {
        this.waiting.delete(pid)
        continue
      }
      if (process.blockedOn !== 'io-burst') continue
      process.burstRemaining--
      if (process.burstRemaining <= 0) {
        this.waiting.delete(pid)
        process.blockedOn = null
        // A well-formed bursts array always starts and ends on a CPU
        // burst (see the class docs), so an I/O burst is never the
        // last element — running off the end only happens for a
        // malformed (even-length) array. Terminating immediately, rather
        // than defaulting burstRemaining to 0 and scheduling a phantom
        // CPU tick next tick, keeps totalBurstTicks exactly equal to the
        // sum of the array's declared CPU-position entries no matter what
        // the caller passed in.
        if (this.advancePastIoBurst(process)) continue
        process.state = 'READY'
        // Rule 3: no demotion on return from I/O — same queue level as before.
        process.sliceRemaining = this.config.quanta[process.queueLevel]
        this.queues[process.queueLevel].push(pid)
      }
    }

    // 3. Anti-starvation priority boost.
    let boosted = false
    if (this.config.boostInterval > 0 && this.tickCount - this.lastBoostTick >= this.config.boostInterval) {
      boosted = true
      this.lastBoostTick = this.tickCount
      for (const level of [1, 2] as const) {
        for (const pid of this.queues[level]) {
          const process = this.processes.get(pid)
          if (!process) continue
          process.queueLevel = 0
          process.sliceRemaining = this.config.quanta[0]
          this.queues[0].push(pid)
        }
        this.queues[level] = []
      }
      const running = this.getRunning()
      if (running && running.queueLevel !== 0) {
        running.queueLevel = 0
        running.sliceRemaining = this.config.quanta[0]
      }
      // Processes blocked on I/O also get amnesty — otherwise a process
      // demoted right before it blocks can miss every boost that happens
      // while it's away and come back to serve out its old, low level.
      // Its sliceRemaining is left alone; the I/O-return step above always
      // resets it to `quanta[queueLevel]`, which will now read level 0.
      for (const pid of this.waiting) {
        const process = this.processes.get(pid)
        if (process) process.queueLevel = 0
      }
    }

    // 4. Preempt the running process if a strictly higher queue is non-empty.
    const running = this.getRunning()
    const higherLevelReady = ([0, 1, 2] as const).find((level) => this.queues[level].length > 0)
    if (running && higherLevelReady !== undefined && higherLevelReady < running.queueLevel) {
      running.state = 'READY'
      this.queues[running.queueLevel].unshift(running.pid)
    }

    // 5. Pick who runs this tick: front of the highest non-empty queue.
    const stillRunning = this.getRunning()
    let winnerPid: number | null = null
    if (stillRunning) {
      winnerPid = stillRunning.pid
    } else {
      const level = ([0, 1, 2] as const).find((l) => this.queues[l].length > 0)
      if (level !== undefined) {
        winnerPid = this.queues[level].shift()!
      }
    }

    // 6. Everyone else still READY accrues waiting time.
    for (const level of [0, 1, 2] as const) {
      for (const pid of this.queues[level]) {
        if (pid === winnerPid) continue
        const process = this.processes.get(pid)
        if (process) process.totalWaitingTicks++
      }
    }

    if (winnerPid !== null && winnerPid !== this.lastRunningPid && this.lastRunningPid !== null) {
      this.globalContextSwitches++
    }
    this.lastRunningPid = winnerPid

    if (winnerPid === null) {
      return { tick: this.tickCount, sample: { tick: this.tickCount, pid: null }, boosted }
    }
    this.busyTicks++

    const winner = this.processes.get(winnerPid)!
    if (winner.state !== 'RUNNING') winner.contextSwitches++
    winner.state = 'RUNNING'
    winner.burstRemaining--
    winner.sliceRemaining--
    winner.totalBurstTicks++

    if (winner.burstRemaining <= 0) {
      const isLastBurst = winner.burstIndex >= winner.bursts.length - 1
      if (isLastBurst) {
        winner.state = 'TERMINATED'
        winner.finishTick = this.tickCount
        this.recordTermination(winner, 'natural')
      } else {
        // The CPU burst finished and the next burst is an I/O one. Offer
        // it to the installed device first (roadmap-v5.md §1.1): if the
        // device takes it, the wait is real — the process sits here until
        // the disk head actually reaches its request and calls wake().
        // With no device installed, or one that declines, the original
        // self-timed countdown in step 2 above resolves it instead, so
        // this engine remains complete and hand-traceable on its own.
        winner.burstIndex++
        winner.burstRemaining = winner.bursts[winner.burstIndex] ?? 0
        const takenByDevice = this.ioPort?.submit(winner.pid, winner.burstRemaining) ?? false
        winner.state = 'WAITING'
        winner.blockedOn = takenByDevice ? 'device' : 'io-burst'
        this.waiting.add(winner.pid)
      }
    } else if (winner.sliceRemaining <= 0) {
      // Rule 4: burned the whole slice without blocking — demote.
      winner.queueLevel = (Math.min(2, winner.queueLevel + 1) as QueueLevel)
      winner.sliceRemaining = this.config.quanta[winner.queueLevel]
      winner.state = 'READY'
      this.queues[winner.queueLevel].push(winner.pid)
    }
    // else: still mid-burst and mid-slice, stays RUNNING into the next tick.

    return { tick: this.tickCount, sample: { tick: this.tickCount, pid: winnerPid }, boosted }
  }
}
