import { describe, expect, it, beforeEach } from 'vitest'
import { SchedulerEngine, createProcess, resetPidCounter } from './engine'

// All processes in these tests are given explicit, hand-computed burst
// sequences (never the randomised generateBursts()) so every assertion
// below can be verified by hand against the textbook definitions:
//   turnaround time = finishTick - arrivalTick
//   waiting time     = turnaround time - total CPU burst time

beforeEach(() => {
  resetPidCounter()
})

describe('SchedulerEngine — quantum demotion (rule 4)', () => {
  it('demotes a CPU-bound process one level each time it exhausts its slice', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('batch', 'cpu-bound', [10])
    engine.spawn(p1)

    for (let i = 0; i < 10; i++) engine.tick()

    expect(p1.state).toBe('TERMINATED')
    expect(p1.finishTick).toBe(10)
    expect(p1.queueLevel).toBe(1) // demoted once after burning the 4-tick Q0 slice
    expect(p1.totalBurstTicks).toBe(10)
    expect(p1.totalWaitingTicks).toBe(0) // sole process, never waits
  })
})

describe('SchedulerEngine — preemption (rule 1)', () => {
  it('lets a freshly-arrived Q0 process preempt a running, demoted process', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('batch', 'cpu-bound', [20])
    engine.spawn(p1)
    for (let i = 0; i < 5; i++) engine.tick() // demotes p1 to Q1 partway through

    expect(p1.queueLevel).toBe(1)
    expect(engine.getRunning()?.pid).toBe(p1.pid)

    const p2 = createProcess('short', 'interactive', [2])
    engine.spawn(p2) // arrives at tick 5, admitted at the top of tick 6

    engine.tick() // tick 6: p2 preempts p1
    expect(engine.getRunning()?.pid).toBe(p2.pid)
    expect(p1.state).toBe('READY')
    expect(p1.queueLevel).toBe(1) // preemption doesn't touch the victim's level

    engine.tick() // tick 7: p2 finishes its 2-tick burst uninterrupted
    expect(p2.state).toBe('TERMINATED')
    expect(p2.finishTick).toBe(7)
    expect(p2.arrivalTick).toBe(5)
    expect(p2.totalWaitingTicks).toBe(0) // never had to wait, it preempted immediately
  })
})

describe('SchedulerEngine — I/O return without demotion (rule 3)', () => {
  it('keeps a process at its queue level when it blocks before its slice expires', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('interactive', 'interactive', [3, 5, 3]) // CPU 3, IO 5, CPU 3
    engine.spawn(p1)

    for (let i = 0; i < 3; i++) engine.tick() // burns its 3-tick CPU burst (< quantum of 4)
    expect(p1.state).toBe('WAITING')
    expect(p1.queueLevel).toBe(0) // never touched the demotion branch

    for (let i = 0; i < 4; i++) engine.tick() // ticks 4-7: still inside the 5-tick IO burst
    expect(p1.state).toBe('WAITING')

    engine.tick() // tick 8: IO completes and it's immediately redispatched (queue is empty)
    expect(p1.state).toBe('RUNNING')
    expect(p1.queueLevel).toBe(0) // rule 3: no demotion on voluntary block

    for (let i = 0; i < 2; i++) engine.tick() // ticks 9-10 finish the final CPU burst
    expect(p1.state).toBe('TERMINATED')
    expect(p1.finishTick).toBe(10)
    expect(p1.totalWaitingTicks).toBe(0) // sole process: CPU just sat idle during its I/O, nobody waited
  })
})

describe('SchedulerEngine — anti-starvation priority boost (rule 5)', () => {
  it('resets a demoted, still-running process back to Q0 after boostInterval ticks', () => {
    const engine = new SchedulerEngine({ quanta: [2, 4, Infinity], boostInterval: 6 })
    const p1 = createProcess('batch', 'cpu-bound', [30])
    engine.spawn(p1)

    engine.tick() // tick 1: Q0
    engine.tick() // tick 2: slice exhausted -> demoted to Q1
    expect(p1.queueLevel).toBe(1)

    engine.tick() // 3
    engine.tick() // 4
    engine.tick() // 5
    const result = engine.tick() // tick 6: boostInterval reached

    expect(result.boosted).toBe(true)
    expect(p1.queueLevel).toBe(0)
  })
})

describe('SchedulerEngine — metrics vs. hand-computed reference values', () => {
  it('matches turnaround = waiting + burst for two sequential processes', () => {
    // Huge quanta => Q0 behaves like plain FCFS, so this is hand-checkable
    // against the classic Silberschatz FCFS waiting-time example shape.
    const engine = new SchedulerEngine({ quanta: [100, 100, Infinity], boostInterval: 0 })
    const p1 = createProcess('p1', 'cpu-bound', [5])
    engine.spawn(p1)
    engine.tick() // tick 1: p1 starts running

    const p2 = createProcess('p2', 'cpu-bound', [3])
    engine.spawn(p2) // arrives at tick 1, admitted at the top of tick 2 — queues behind p1

    for (let i = 0; i < 4; i++) engine.tick() // ticks 2-5: p1 runs to completion
    expect(p1.state).toBe('TERMINATED')
    expect(p1.finishTick).toBe(5)
    expect(p1.totalWaitingTicks).toBe(0)

    for (let i = 0; i < 3; i++) engine.tick() // ticks 6-8: p2 finally runs
    expect(p2.state).toBe('TERMINATED')
    expect(p2.finishTick).toBe(8)
    expect(p2.arrivalTick).toBe(1)
    expect(p2.totalWaitingTicks).toBe(4) // waited ticks 2-5 while p1 ran

    // turnaround = finish - arrival; waiting = turnaround - burst (textbook identity)
    expect(p1.finishTick! - p1.arrivalTick).toBe(0 + 5)
    expect(p2.finishTick! - p2.arrivalTick).toBe(p2.totalWaitingTicks + 3)

    const metrics = engine.getMetrics()
    expect(metrics.completed).toBe(2)
    expect(metrics.avgWaitingTicks).toBeCloseTo((0 + 4) / 2)
    expect(metrics.avgTurnaroundTicks).toBeCloseTo((5 + 7) / 2)
    expect(metrics.contextSwitches).toBe(1) // exactly one real p1 -> p2 handoff
    expect(metrics.cpuUtilization).toBeCloseTo(1) // no idle ticks anywhere
  })
})

describe('SchedulerEngine — kill()', () => {
  it('removes the killed process from scheduling without disturbing the others', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('victim', 'cpu-bound', [20])
    const p2 = createProcess('survivor', 'cpu-bound', [3])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick() // p1 dispatched first (arrived first)

    const killed = engine.kill(p1.pid)
    expect(killed?.state).toBe('TERMINATED')
    expect(engine.getRunning()?.pid).toBeUndefined()

    engine.tick() // p2 should now be picked up
    expect(engine.getRunning()?.pid).toBe(p2.pid)

    expect(engine.kill(999)).toBeUndefined() // unknown pid is a no-op
    expect(engine.kill(p1.pid)).toBeUndefined() // already-terminated pid is a no-op
  })
})
