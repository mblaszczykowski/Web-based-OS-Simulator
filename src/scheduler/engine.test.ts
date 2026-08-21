import { describe, expect, it, beforeEach } from 'vitest'
import { SchedulerEngine, createProcess, resetPidCounter } from './engine'
import { simBus } from '../shared/eventBus'
import { INIT_PID, SHELL_PID } from '../shared/types'

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

describe('SchedulerEngine — stop() / cont() (roadmap-v3.md §2.2, SIGSTOP/SIGCONT)', () => {
  it('freezes a RUNNING process — no burst consumed while stopped, resumes into READY on cont()', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('victim', 'cpu-bound', [10])
    engine.spawn(p1)
    engine.tick() // p1 running, burstRemaining now 9

    const stopped = engine.stop(p1.pid)
    expect(stopped?.state).toBe('STOPPED')
    expect(engine.getRunning()).toBeUndefined() // CPU is free — nobody else to run

    engine.tick()
    engine.tick()
    expect(p1.state).toBe('STOPPED')
    expect(p1.burstRemaining).toBe(9) // unchanged — tick() never touched it while stopped

    const resumed = engine.cont(p1.pid)
    expect(resumed?.state).toBe('READY')
    expect(p1.queueLevel).toBe(0) // no demotion, same level as before

    engine.tick() // re-admitted from the ready queue
    expect(engine.getRunning()?.pid).toBe(p1.pid)
    expect(p1.burstRemaining).toBe(8) // resumes counting down from where it was frozen
  })

  it('pulls a READY (queued) process out of its queue while stopped, so it cannot be dispatched', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('running', 'cpu-bound', [20])
    const p2 = createProcess('queued', 'cpu-bound', [5])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick() // p1 runs, p2 sits READY in Q0

    expect(p2.state).toBe('READY')
    engine.stop(p2.pid)
    expect(p2.state).toBe('STOPPED')

    engine.kill(p1.pid) // free the CPU
    engine.tick()
    expect(engine.getRunning()).toBeUndefined() // p2 would have run next, but it's stopped, not queued

    engine.cont(p2.pid)
    engine.tick()
    expect(engine.getRunning()?.pid).toBe(p2.pid)
  })

  it('is idempotent: stopping an already-stopped process, or continuing one that is not stopped, is a harmless no-op', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('p', 'cpu-bound', [10])
    engine.spawn(p1)
    engine.tick()

    expect(engine.cont(p1.pid)?.state).toBe('RUNNING') // wasn't stopped — no-op, still returns the process
    engine.stop(p1.pid)
    expect(engine.stop(p1.pid)?.state).toBe('STOPPED') // already stopped — no-op, still returns the process
  })

  it('refuses to stop or continue an unknown or already-terminated pid', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('p', 'cpu-bound', [1])
    engine.spawn(p1)
    engine.kill(p1.pid)

    expect(engine.stop(999)).toBeUndefined()
    expect(engine.cont(999)).toBeUndefined()
    expect(engine.stop(p1.pid)).toBeUndefined()
    expect(engine.cont(p1.pid)).toBeUndefined()
  })

  it('regression: repeated SIGSTOP/SIGCONT cannot dodge MLFQ demotion by granting endless fresh quanta (found by code review)', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('hog', 'cpu-bound', [100])
    engine.spawn(p1)

    engine.tick() // 1
    engine.tick() // 2
    engine.tick() // 3 — one tick left in the 4-tick Q0 quantum
    expect(p1.queueLevel).toBe(0)
    expect(p1.sliceRemaining).toBe(1)

    // Stop and resume repeatedly right at this exact point in the slice —
    // a version that reset sliceRemaining to a fresh quantum on cont()
    // would let this process sit at Q0 forever, never demoted.
    for (let i = 0; i < 5; i++) {
      engine.stop(p1.pid)
      engine.cont(p1.pid)
      expect(p1.sliceRemaining).toBe(1) // unchanged by the stop/cont cycle itself
    }

    engine.tick() // the 4th tick of the ORIGINAL quantum — must demote now
    expect(p1.queueLevel).toBe(1)
  })

  it('regression: resuming a process stopped mid-I/O-burst treats that I/O as complete instead of miscounting the wait as CPU time (found by code review)', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    // CPU 2, IO 5, CPU 3 — burstIndex 1 (the IO burst) is where we'll stop it.
    const p1 = createProcess('interactive', 'interactive', [2, 5, 3])
    engine.spawn(p1)
    engine.tick()
    engine.tick() // burns the 2-tick CPU burst -> WAITING, burstIndex 1, burstRemaining 5
    expect(p1.state).toBe('WAITING')
    expect(p1.burstIndex).toBe(1)

    engine.stop(p1.pid)
    expect(p1.state).toBe('STOPPED')

    const resumed = engine.cont(p1.pid)
    expect(resumed?.state).toBe('READY')
    // The I/O burst is treated as having just completed: burstIndex
    // advances to the final CPU burst, with a fresh slice — exactly what
    // the real I/O-return step in tick() would have done.
    expect(p1.burstIndex).toBe(2)
    expect(p1.burstRemaining).toBe(3)
    expect(p1.sliceRemaining).toBe(4)

    engine.tick() // dispatched
    engine.tick()
    engine.tick() // finishes its real final 3-tick CPU burst
    expect(p1.state).toBe('TERMINATED')
    // totalBurstTicks only ever counted genuine CPU bursts (2 + 3 = 5) —
    // the abandoned I/O wait was never miscounted as CPU work.
    expect(p1.totalBurstTicks).toBe(5)
  })
})

describe('SchedulerEngine — process:terminated event', () => {
  it('is emitted exactly once for a killed process and once for a naturally-finished one', () => {
    const engine = new SchedulerEngine({ quanta: [100, 100, Infinity], boostInterval: 0 })
    const events: { pid: number; reason: string }[] = []
    const unsubscribe = simBus.on('process:terminated', (e) => events.push({ pid: e.pid, reason: e.reason }))

    const p1 = createProcess('victim', 'cpu-bound', [10])
    const p2 = createProcess('natural', 'cpu-bound', [1])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick() // p1 dispatched (arrived first)
    engine.kill(p1.pid)
    engine.tick() // p2 dispatched and finishes its 1-tick burst immediately

    unsubscribe()
    expect(events).toEqual([
      { pid: p1.pid, reason: 'killed' },
      { pid: p2.pid, reason: 'natural' },
    ])
  })
})

describe('SchedulerEngine — priority boost reaches I/O-blocked processes too', () => {
  it('resets queueLevel even for a process currently WAITING on I/O', () => {
    const engine = new SchedulerEngine({ quanta: [2, 4, Infinity], boostInterval: 6 })
    const p1 = createProcess('interactive', 'interactive', [5, 10, 3]) // CPU 5, IO 10, CPU 3
    engine.spawn(p1)

    engine.tick() // 1: Q0
    engine.tick() // 2: slice exhausted -> demoted to Q1
    expect(p1.queueLevel).toBe(1)
    engine.tick() // 3
    engine.tick() // 4
    engine.tick() // 5: burst completes mid-slice -> WAITING, still at Q1
    expect(p1.state).toBe('WAITING')
    expect(p1.queueLevel).toBe(1)

    const result = engine.tick() // 6: boostInterval reached while p1 is WAITING
    expect(result.boosted).toBe(true)
    expect(p1.state).toBe('WAITING') // still mid-IO, unaffected by the boost otherwise
    expect(p1.queueLevel).toBe(0) // but its level was reset regardless
  })
})

describe('SchedulerEngine — bounded process history', () => {
  it('prunes old terminated processes but keeps lifetime metrics exact', () => {
    const engine = new SchedulerEngine({ quanta: [100, 100, Infinity], boostInterval: 0 })
    const total = 20 // > MAX_TERMINATED_HISTORY (15)
    for (let i = 0; i < total; i++) {
      engine.spawn(createProcess(`p${i}`, 'cpu-bound', [1]))
    }
    for (let i = 0; i < total; i++) engine.tick() // one process finishes per tick, FCFS-style

    // getProcesses() is what backs the UI's process list — it must not grow forever.
    expect(engine.getProcesses().length).toBeLessThanOrEqual(15)

    // but the lifetime averages must still reflect all 20, not just the retained ones
    const metrics = engine.getMetrics()
    expect(metrics.completed).toBe(20)
    expect(metrics.avgWaitingTicks).toBeCloseTo((0 + 19) / 2) // waits 0,1,2,...,19
    expect(metrics.avgTurnaroundTicks).toBeCloseTo((1 + 20) / 2) // finishes at tick 1,2,...,20
  })
})

describe('createProcess — parentPid (roadmap.md §2.2)', () => {
  it('defaults to INIT_PID, and accepts an explicit parent (e.g. SHELL_PID for `run`)', () => {
    const auto = createProcess('backupd', 'cpu-bound', [5])
    expect(auto.parentPid).toBe(INIT_PID)

    const fromShell = createProcess('compiler', 'cpu-bound', [5], SHELL_PID)
    expect(fromShell.parentPid).toBe(SHELL_PID)
  })
})

describe('SchedulerEngine — malformed (even-length) bursts array', () => {
  // Found by the property test in engine.property.test.ts: a well-formed
  // bursts array always starts and ends on a CPU burst (odd length), but
  // nothing enforces that at the type level. An even-length array used to
  // schedule one extra "phantom" CPU tick past the end of the array
  // before terminating, silently over-counting totalBurstTicks.
  it('terminates right after the last I/O burst finishes, without burning a phantom CPU tick', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('odd-input', 'cpu-bound', [1, 1]) // CPU 1, IO 1 — ends on I/O, not CPU
    engine.spawn(p1)

    engine.tick() // runs the 1-tick CPU burst, then blocks for I/O
    expect(p1.state).toBe('WAITING')

    engine.tick() // I/O burst finishes; no further burst exists -> terminates here, not next tick
    expect(p1.state).toBe('TERMINATED')
    expect(p1.finishTick).toBe(2)
    expect(p1.totalBurstTicks).toBe(1) // exactly the declared CPU burst, no phantom extra tick
  })
})
