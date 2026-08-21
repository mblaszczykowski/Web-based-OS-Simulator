import type { GanttSample, Process, ProcessKind, QueueLevel } from '../shared/types'
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

export function createProcess(name: string, kind: ProcessKind, bursts = generateBursts(kind)): Process {
  return {
    pid: nextPid(),
    name,
    kind,
    state: 'NEW',
    queueLevel: 0,
    arrivalTick: 0,
    finishTick: null,
    bursts,
    burstIndex: 0,
    burstRemaining: bursts[0] ?? 0,
    sliceRemaining: DEFAULT_SCHEDULER_CONFIG.quanta[0],
    totalWaitingTicks: 0,
    totalBurstTicks: 0,
    contextSwitches: 0,
    pageCount: 2 + Math.floor(Math.random() * 5),
  }
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
  private waiting = new Set<number>()
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
   * Single choke point for every state transition into TERMINATED — both
   * kill() and tick()'s natural-completion branch call this exactly once
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

    simBus.emit('process:terminated', { pid: process.pid, name: process.name, reason })
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
    process.finishTick = this.tickCount
    this.recordTermination(process, 'killed')
    return process
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

    // 2. Resolve I/O completions.
    for (const pid of [...this.waiting]) {
      const process = this.processes.get(pid)
      if (!process) {
        this.waiting.delete(pid)
        continue
      }
      process.burstRemaining--
      if (process.burstRemaining <= 0) {
        process.burstIndex++
        process.burstRemaining = process.bursts[process.burstIndex] ?? 0
        process.state = 'READY'
        // Rule 3: no demotion on return from I/O — same queue level as before.
        process.sliceRemaining = this.config.quanta[process.queueLevel]
        this.queues[process.queueLevel].push(pid)
        this.waiting.delete(pid)
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
        winner.burstIndex++
        winner.burstRemaining = winner.bursts[winner.burstIndex] ?? 0
        winner.state = 'WAITING'
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
