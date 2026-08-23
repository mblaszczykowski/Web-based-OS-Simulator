import { INIT_PID, type BlockReason, type GanttSample, type Process, type ProcessKind, type QueueLevel } from '../shared/types'
import { simBus } from '../shared/eventBus'

export interface SchedulerConfig {
  /** Time slice per queue level. Q2 is Infinity, i.e. FCFS. */
  quanta: readonly [number, number, number]
  /** Boost everything back to Q0 every N ticks. 0 disables it. */
  boostInterval: number
  /** CPUs to schedule onto, each with its own set of queues. Defaults to 1. */
  coreCount?: number
  /** Ticks between load-balancing passes. 0 disables migration, leaving pure affinity. */
  balanceInterval?: number
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  quanta: [4, 8, Infinity],
  boostInterval: 50,
  coreCount: 2,
  balanceInterval: 20,
}

// Migrating on a difference of one would leave two cores swapping the same
// process forever, since the move just inverts the imbalance.
const MIGRATION_THRESHOLD = 2

export interface TickResult {
  tick: number
  sample: GanttSample
  boosted: boolean
}

let pidCounter = 1
export function nextPid(): number {
  return pidCounter++
}

export function resetPidCounter(start = 1): void {
  pidCounter = start
}

/**
 * Alternating CPU/IO burst sequence, always starting and ending on a CPU
 * burst. Interactive processes get many short bursts; CPU-bound ones get
 * few long ones.
 */
export function generateBursts(kind: ProcessKind): number[] {
  const bursts: number[] = []
  if (kind === 'interactive') {
    const cycles = 2 + Math.floor(Math.random() * 3)
    for (let i = 0; i < cycles; i++) {
      bursts.push(2 + Math.floor(Math.random() * 4))
      if (i < cycles - 1) bursts.push(3 + Math.floor(Math.random() * 6))
    }
  } else {
    const cycles = 1 + Math.floor(Math.random() * 2)
    for (let i = 0; i < cycles; i++) {
      bursts.push(8 + Math.floor(Math.random() * 13))
      if (i < cycles - 1) bursts.push(1 + Math.floor(Math.random() * 3))
    }
  }
  return bursts
}

export interface CreateProcessOptions {
  memoryOwnerPid?: number
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
    core: null,
    totalWaitingTicks: 0,
    totalBurstTicks: 0,
    contextSwitches: 0,
    pageCount: opts.pageCount ?? 2 + Math.floor(Math.random() * 5),
  }
}

/**
 * Lets a device take ownership of a process's I/O wait. Keeps this engine
 * free of any knowledge of disks: it only knows a wait may be owned
 * elsewhere. Returning false falls back to the self-timed countdown, so a
 * process can never be lost.
 */
export interface IoPort {
  submit(pid: number, sizeHint: number): boolean
}

const MAX_TERMINATED_HISTORY = 15

/**
 * Multi-Level Feedback Queue scheduler over N CPUs.
 *
 *  1. A higher queue (lower index) always preempts a lower one.
 *  2. Equal priority round-robins on that level's quantum.
 *  3. Blocking for I/O before the slice expires keeps the queue level.
 *  4. Burning a whole slice without blocking demotes one level.
 *  5. Every boostInterval ticks everything returns to Q0, so a long batch
 *     job can't starve anything forever.
 *
 * Each CPU owns a complete set of queues. A process is assigned one on
 * admission and stays there (affinity); only the load balancer moves it.
 */
export class SchedulerEngine {
  private processes = new Map<number, Process>()
  private queues: [number[], number[], number[]][]
  /** Every WAITING process. Only blockedOn === 'io-burst' is counted down here. */
  private waiting = new Set<number>()
  private ioPort: IoPort | null = null
  private pendingArrivals: number[] = []
  private tickCount = 0
  private lastBoostTick = 0
  private lastRunningPid: (number | null)[]
  private globalContextSwitches = 0
  private busyTicks = 0
  private lastBalanceTick = 0
  private migrations = 0

  // Lifetime aggregates outlive pruning, so metrics stay accurate after old
  // dead processes are dropped from `processes`.
  private terminatedHistory: number[] = []
  private terminatedCount = 0
  private terminatedWaitingTicks = 0
  private terminatedTurnaroundTicks = 0

  constructor(private config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG) {
    this.queues = Array.from({ length: this.coreCount }, () => [[], [], []] as [number[], number[], number[]])
    this.lastRunningPid = Array(this.coreCount).fill(null)
  }

  get coreCount(): number {
    return Math.max(1, this.config.coreCount ?? 1)
  }

  get cores(): number[] {
    return Array.from({ length: this.coreCount }, (_, i) => i)
  }

  private leastLoadedCore(): number {
    const load = Array(this.coreCount).fill(0)
    for (const process of this.processes.values()) {
      if (process.state === 'TERMINATED' || process.core === null) continue
      load[process.core]!++
    }
    let best = 0
    for (let core = 1; core < this.coreCount; core++) {
      if (load[core]! < load[best]!) best = core
    }
    return best
  }

  /** Queued plus the one on the CPU — counting only the queue would make an idle core look balanced. */
  private runnableLoad(): number[] {
    return this.cores.map(
      (core) =>
        this.queues[core]!.reduce((sum, queue) => sum + queue.length, 0) + (this.getRunning(core) === undefined ? 0 : 1),
    )
  }

  /** Scans every core, not just process.core: the balancer moves processes between them. */
  private dequeue(pid: number): void {
    for (const levels of this.queues) {
      for (let level = 0; level < levels.length; level++) {
        levels[level] = levels[level]!.filter((p) => p !== pid)
      }
    }
  }

  /** Also assigns a core to a process that has none, so nothing lands in a queue no CPU owns. */
  private enqueue(process: Process, front = false): void {
    if (process.core === null) process.core = this.leastLoadedCore()
    const queue = this.queues[process.core]![process.queueLevel]!
    if (front) queue.unshift(process.pid)
    else queue.push(process.pid)
  }

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

    this.dequeue(pid)
    this.waiting.delete(pid)
    this.pendingArrivals = this.pendingArrivals.filter((p) => p !== pid)

    process.state = 'TERMINATED'
    process.blockedOn = null
    process.finishTick = this.tickCount
    this.recordTermination(process, 'killed')
    return process
  }

  stop(pid: number): Process | undefined {
    const process = this.processes.get(pid)
    if (!process || process.state === 'TERMINATED') return undefined
    if (process.state === 'STOPPED') return process

    this.dequeue(pid)
    this.waiting.delete(pid)
    this.pendingArrivals = this.pendingArrivals.filter((p) => p !== pid)
    process.state = 'STOPPED'
    return process
  }

  /** Resumes into READY, or back into WAITING if the process was blocked when it was stopped. */
  cont(pid: number): Process | undefined {
    const process = this.processes.get(pid)
    if (!process || process.state === 'TERMINATED') return undefined
    if (process.state !== 'STOPPED') return process

    if (process.blockedOn !== null) {
      process.state = 'WAITING'
      this.waiting.add(pid)
      return process
    }
    process.state = 'READY'
    this.enqueue(process)
    return process
  }

  setIoPort(port: IoPort | null): void {
    this.ioPort = port
  }

  /** Parks a runnable process on something outside the scheduler. Refuses one that isn't runnable. */
  blockOn(pid: number, reason: Exclude<BlockReason, 'io-burst'>): boolean {
    const process = this.processes.get(pid)
    if (!process) return false
    if (process.state !== 'RUNNING' && process.state !== 'READY') return false

    this.dequeue(pid)
    process.state = 'WAITING'
    process.blockedOn = reason
    this.waiting.add(pid)
    return true
  }

  /**
   * The interrupt: whatever owned this wait says it is finished. `reason`
   * must match, so a pipe can't accidentally resolve a disk wait (which
   * would advance the process past an I/O burst it never served).
   * A wake for a STOPPED process is honoured but doesn't ready it.
   */
  wake(pid: number, reason: Exclude<BlockReason, 'io-burst'>): boolean {
    const process = this.processes.get(pid)
    if (!process || process.state === 'TERMINATED') return false
    if (process.blockedOn !== reason) return false

    process.blockedOn = null
    this.waiting.delete(pid)
    if (reason === 'device' && this.advancePastIoBurst(process)) return true
    if (process.state === 'STOPPED') return true

    process.state = 'READY'
    process.sliceRemaining = this.config.quanta[process.queueLevel]
    this.enqueue(process)
    return true
  }

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

  getReadyQueues(core?: number): [Process[], Process[], Process[]] {
    const levels = ([0, 1, 2] as const).map((level) =>
      (core === undefined ? this.queues.flatMap((q) => q[level]) : (this.queues[core]?.[level] ?? []))
        .map((pid) => this.processes.get(pid))
        .filter((p): p is Process => p !== undefined),
    )
    return levels as [Process[], Process[], Process[]]
  }

  getRunningProcesses(): (Process | undefined)[] {
    return this.cores.map((core) => this.getProcesses().find((p) => p.state === 'RUNNING' && p.core === core))
  }

  getRunning(core?: number): Process | undefined {
    return this.getProcesses().find((p) => p.state === 'RUNNING' && (core === undefined || p.core === core))
  }

  getMetrics() {
    const n = this.terminatedCount
    return {
      completed: n,
      avgWaitingTicks: n ? this.terminatedWaitingTicks / n : 0,
      avgTurnaroundTicks: n ? this.terminatedTurnaroundTicks / n : 0,
      contextSwitches: this.globalContextSwitches,
      cpuUtilization: this.tickCount ? this.busyTicks / (this.tickCount * this.coreCount) : 0,
      coreCount: this.coreCount,
      migrations: this.migrations,
      loadPerCore: this.runnableLoad(),
    }
  }

  tick(): TickResult {
    this.tickCount++

    for (const pid of this.pendingArrivals) {
      const process = this.processes.get(pid)
      if (!process) continue
      process.state = 'READY'
      process.queueLevel = 0
      process.sliceRemaining = this.config.quanta[0]
      process.core = this.leastLoadedCore()
      this.enqueue(process)
    }
    this.pendingArrivals = []

    // Only the self-timed waits this engine owns; a process parked on a real
    // device or a pipe leaves this set through wake() alone.
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
        if (this.advancePastIoBurst(process)) continue
        process.state = 'READY'
        process.sliceRemaining = this.config.quanta[process.queueLevel]
        this.enqueue(process)
      }
    }

    let boosted = false
    if (this.config.boostInterval > 0 && this.tickCount - this.lastBoostTick >= this.config.boostInterval) {
      boosted = true
      this.lastBoostTick = this.tickCount
      for (const levels of this.queues) {
        for (const level of [1, 2] as const) {
          for (const pid of levels[level]) {
            const process = this.processes.get(pid)
            if (!process) continue
            process.queueLevel = 0
            process.sliceRemaining = this.config.quanta[0]
            levels[0].push(pid)
          }
          levels[level] = []
        }
      }
      for (const running of this.getRunningProcesses()) {
        if (running && running.queueLevel !== 0) {
          running.queueLevel = 0
          running.sliceRemaining = this.config.quanta[0]
        }
      }
      for (const pid of this.waiting) {
        const process = this.processes.get(pid)
        if (process) process.queueLevel = 0
      }
    }

    this.balanceLoad()

    for (const core of this.cores) {
      const running = this.getRunning(core)
      const levels = this.queues[core]!
      const higherLevelReady = ([0, 1, 2] as const).find((level) => levels[level].length > 0)
      if (running && higherLevelReady !== undefined && higherLevelReady < running.queueLevel) {
        running.state = 'READY'
        this.enqueue(running, true)
      }
    }

    // Every core is chosen before any of them runs, so no CPU can pick up a
    // process another is about to be handed.
    const winners: (number | null)[] = this.cores.map((core) => {
      const stillRunning = this.getRunning(core)
      if (stillRunning) return stillRunning.pid
      const levels = this.queues[core]!
      const level = ([0, 1, 2] as const).find((l) => levels[l].length > 0)
      return level === undefined ? null : levels[level].shift()!
    })

    const running = new Set(winners.filter((pid): pid is number => pid !== null))
    for (const levels of this.queues) {
      for (const queue of levels) {
        for (const pid of queue) {
          if (running.has(pid)) continue
          const process = this.processes.get(pid)
          if (process) process.totalWaitingTicks++
        }
      }
    }

    for (const core of this.cores) {
      const winnerPid = winners[core]!
      if (winnerPid !== null && winnerPid !== this.lastRunningPid[core] && this.lastRunningPid[core] !== null) {
        this.globalContextSwitches++
      }
      this.lastRunningPid[core] = winnerPid
      if (winnerPid !== null) this.runOneTick(winnerPid)
    }

    return { tick: this.tickCount, sample: { tick: this.tickCount, pids: winners }, boosted }
  }

  /**
   * Moves one process from the busiest CPU to the idlest, taking the front
   * of its lowest-priority queue: batch work that has waited longest, so
   * the coldest cache and the least lost by moving.
   */
  private balanceLoad(): void {
    const interval = this.config.balanceInterval ?? 0
    if (this.coreCount < 2 || interval <= 0) return
    if (this.tickCount - this.lastBalanceTick < interval) return
    this.lastBalanceTick = this.tickCount

    const load = this.runnableLoad()
    let busiest = 0
    let idlest = 0
    for (const core of this.cores) {
      if (load[core]! > load[busiest]!) busiest = core
      if (load[core]! < load[idlest]!) idlest = core
    }
    if (busiest === idlest || load[busiest]! - load[idlest]! < MIGRATION_THRESHOLD) return

    const levels = this.queues[busiest]!
    for (const level of [2, 1, 0] as const) {
      const pid = levels[level].shift()
      if (pid === undefined) continue
      const process = this.processes.get(pid)
      if (!process) continue
      process.core = idlest
      this.enqueue(process)
      this.migrations++
      return
    }
  }

  private runOneTick(winnerPid: number): void {
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
        // Offer the I/O to the device; if it takes it, nothing counts down here.
        const takenByDevice = this.ioPort?.submit(winner.pid, winner.burstRemaining) ?? false
        winner.state = 'WAITING'
        winner.blockedOn = takenByDevice ? 'device' : 'io-burst'
        this.waiting.add(winner.pid)
      }
    } else if (winner.sliceRemaining <= 0) {
      winner.queueLevel = (Math.min(2, winner.queueLevel + 1) as QueueLevel)
      winner.sliceRemaining = this.config.quanta[winner.queueLevel]
      winner.state = 'READY'
      this.enqueue(winner)
    }
  }
}
