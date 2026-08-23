import { describe, expect, it, beforeEach } from 'vitest'
import { SchedulerEngine, createProcess, resetPidCounter } from './engine'
import { simBus } from '../shared/eventBus'
import { INIT_PID, SHELL_PID } from '../shared/types'

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
    expect(p1.queueLevel).toBe(1)
    expect(p1.totalBurstTicks).toBe(10)
    expect(p1.totalWaitingTicks).toBe(0)
  })
})

describe('SchedulerEngine — preemption (rule 1)', () => {
  it('lets a freshly-arrived Q0 process preempt a running, demoted process', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('batch', 'cpu-bound', [20])
    engine.spawn(p1)
    for (let i = 0; i < 5; i++) engine.tick()

    expect(p1.queueLevel).toBe(1)
    expect(engine.getRunning()?.pid).toBe(p1.pid)

    const p2 = createProcess('short', 'interactive', [2])
    engine.spawn(p2)

    engine.tick()
    expect(engine.getRunning()?.pid).toBe(p2.pid)
    expect(p1.state).toBe('READY')
    expect(p1.queueLevel).toBe(1)

    engine.tick()
    expect(p2.state).toBe('TERMINATED')
    expect(p2.finishTick).toBe(7)
    expect(p2.arrivalTick).toBe(5)
    expect(p2.totalWaitingTicks).toBe(0)
  })
})

describe('SchedulerEngine — I/O return without demotion (rule 3)', () => {
  it('keeps a process at its queue level when it blocks before its slice expires', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('interactive', 'interactive', [3, 5, 3])
    engine.spawn(p1)

    for (let i = 0; i < 3; i++) engine.tick()
    expect(p1.state).toBe('WAITING')
    expect(p1.queueLevel).toBe(0)

    for (let i = 0; i < 4; i++) engine.tick()
    expect(p1.state).toBe('WAITING')

    engine.tick()
    expect(p1.state).toBe('RUNNING')
    expect(p1.queueLevel).toBe(0)

    for (let i = 0; i < 2; i++) engine.tick()
    expect(p1.state).toBe('TERMINATED')
    expect(p1.finishTick).toBe(10)
    expect(p1.totalWaitingTicks).toBe(0)
  })
})

describe('SchedulerEngine — anti-starvation priority boost (rule 5)', () => {
  it('resets a demoted, still-running process back to Q0 after boostInterval ticks', () => {
    const engine = new SchedulerEngine({ quanta: [2, 4, Infinity], boostInterval: 6 })
    const p1 = createProcess('batch', 'cpu-bound', [30])
    engine.spawn(p1)

    engine.tick()
    engine.tick()
    expect(p1.queueLevel).toBe(1)

    engine.tick()
    engine.tick()
    engine.tick()
    const result = engine.tick()

    expect(result.boosted).toBe(true)
    expect(p1.queueLevel).toBe(0)
  })
})

describe('SchedulerEngine — metrics vs. hand-computed reference values', () => {
  it('matches turnaround = waiting + burst for two sequential processes', () => {
    const engine = new SchedulerEngine({ quanta: [100, 100, Infinity], boostInterval: 0 })
    const p1 = createProcess('p1', 'cpu-bound', [5])
    engine.spawn(p1)
    engine.tick()

    const p2 = createProcess('p2', 'cpu-bound', [3])
    engine.spawn(p2)

    for (let i = 0; i < 4; i++) engine.tick()
    expect(p1.state).toBe('TERMINATED')
    expect(p1.finishTick).toBe(5)
    expect(p1.totalWaitingTicks).toBe(0)

    for (let i = 0; i < 3; i++) engine.tick()
    expect(p2.state).toBe('TERMINATED')
    expect(p2.finishTick).toBe(8)
    expect(p2.arrivalTick).toBe(1)
    expect(p2.totalWaitingTicks).toBe(4)

    expect(p1.finishTick! - p1.arrivalTick).toBe(0 + 5)
    expect(p2.finishTick! - p2.arrivalTick).toBe(p2.totalWaitingTicks + 3)

    const metrics = engine.getMetrics()
    expect(metrics.completed).toBe(2)
    expect(metrics.avgWaitingTicks).toBeCloseTo((0 + 4) / 2)
    expect(metrics.avgTurnaroundTicks).toBeCloseTo((5 + 7) / 2)
    expect(metrics.contextSwitches).toBe(1)
    expect(metrics.cpuUtilization).toBeCloseTo(1)
  })
})

describe('SchedulerEngine — kill()', () => {
  it('removes the killed process from scheduling without disturbing the others', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('victim', 'cpu-bound', [20])
    const p2 = createProcess('survivor', 'cpu-bound', [3])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick()

    const killed = engine.kill(p1.pid)
    expect(killed?.state).toBe('TERMINATED')
    expect(engine.getRunning()?.pid).toBeUndefined()

    engine.tick()
    expect(engine.getRunning()?.pid).toBe(p2.pid)

    expect(engine.kill(999)).toBeUndefined()
    expect(engine.kill(p1.pid)).toBeUndefined()
  })
})

describe('SchedulerEngine — stop() / cont() (, SIGSTOP/SIGCONT)', () => {
  it('freezes a RUNNING process — no burst consumed while stopped, resumes into READY on cont()', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('victim', 'cpu-bound', [10])
    engine.spawn(p1)
    engine.tick()

    const stopped = engine.stop(p1.pid)
    expect(stopped?.state).toBe('STOPPED')
    expect(engine.getRunning()).toBeUndefined()

    engine.tick()
    engine.tick()
    expect(p1.state).toBe('STOPPED')
    expect(p1.burstRemaining).toBe(9)

    const resumed = engine.cont(p1.pid)
    expect(resumed?.state).toBe('READY')
    expect(p1.queueLevel).toBe(0)

    engine.tick()
    expect(engine.getRunning()?.pid).toBe(p1.pid)
    expect(p1.burstRemaining).toBe(8)
  })

  it('pulls a READY (queued) process out of its queue while stopped, so it cannot be dispatched', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('running', 'cpu-bound', [20])
    const p2 = createProcess('queued', 'cpu-bound', [5])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick()

    expect(p2.state).toBe('READY')
    engine.stop(p2.pid)
    expect(p2.state).toBe('STOPPED')

    engine.kill(p1.pid)
    engine.tick()
    expect(engine.getRunning()).toBeUndefined()

    engine.cont(p2.pid)
    engine.tick()
    expect(engine.getRunning()?.pid).toBe(p2.pid)
  })

  it('is idempotent: stopping an already-stopped process, or continuing one that is not stopped, is a harmless no-op', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('p', 'cpu-bound', [10])
    engine.spawn(p1)
    engine.tick()

    expect(engine.cont(p1.pid)?.state).toBe('RUNNING')
    engine.stop(p1.pid)
    expect(engine.stop(p1.pid)?.state).toBe('STOPPED')
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

  it('regression: repeated SIGSTOP/SIGCONT cannot dodge MLFQ demotion by granting endless fresh quanta', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('hog', 'cpu-bound', [100])
    engine.spawn(p1)

    engine.tick()
    engine.tick()
    engine.tick()
    expect(p1.queueLevel).toBe(0)
    expect(p1.sliceRemaining).toBe(1)

    for (let i = 0; i < 5; i++) {
      engine.stop(p1.pid)
      engine.cont(p1.pid)
      expect(p1.sliceRemaining).toBe(1)
    }

    engine.tick()
    expect(p1.queueLevel).toBe(1)
  })

  it('resuming a process stopped mid-I/O-burst puts it back in WAITING, with the rest of that wait still to serve', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('interactive', 'interactive', [2, 5, 3])
    engine.spawn(p1)
    engine.tick()
    engine.tick()
    expect(p1.state).toBe('WAITING')
    expect(p1.burstIndex).toBe(1)
    expect(p1.blockedOn).toBe('io-burst')

    engine.tick()
    expect(p1.burstRemaining).toBe(4)

    engine.stop(p1.pid)
    expect(p1.state).toBe('STOPPED')
    expect(p1.blockedOn).toBe('io-burst')
    engine.tick()
    engine.tick()
    expect(p1.burstRemaining).toBe(4)

    const resumed = engine.cont(p1.pid)
    expect(resumed?.state).toBe('WAITING')
    expect(p1.burstIndex).toBe(1)
    expect(p1.burstRemaining).toBe(4)

    for (let i = 0; i < 3; i++) engine.tick()
    expect(p1.state).toBe('WAITING')
    expect(p1.burstRemaining).toBe(1)

    engine.tick()
    expect(p1.state).toBe('RUNNING')
    expect(p1.blockedOn).toBeNull()
    expect(p1.burstIndex).toBe(2)
    expect(p1.burstRemaining).toBe(2)

    engine.tick()
    engine.tick()
    expect(p1.state).toBe('TERMINATED')
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
    engine.tick()
    engine.kill(p1.pid)
    engine.tick()

    unsubscribe()
    expect(events).toEqual([
      { pid: p1.pid, reason: 'killed' },
      { pid: p2.pid, reason: 'natural' },
    ])
  })

  it('carries the process\'s memoryOwnerPid, so a thread-group-aware subscriber can tell whether shared memory is safe to free', () => {
    const engine = new SchedulerEngine({ quanta: [100, 100, Infinity], boostInterval: 0 })
    const events: { pid: number; memoryOwnerPid: number }[] = []
    const unsubscribe = simBus.on('process:terminated', (e) => events.push({ pid: e.pid, memoryOwnerPid: e.memoryOwnerPid }))

    const leader = createProcess('leader', 'cpu-bound', [1])
    const thread = createProcess('thread', 'cpu-bound', [1], SHELL_PID, { memoryOwnerPid: leader.pid })
    engine.spawn(leader)
    engine.spawn(thread)
    engine.kill(leader.pid)
    engine.kill(thread.pid)

    unsubscribe()
    expect(events).toEqual([
      { pid: leader.pid, memoryOwnerPid: leader.pid },
      { pid: thread.pid, memoryOwnerPid: leader.pid },
    ])
  })
})

describe('createProcess — memoryOwnerPid/pageCount options', () => {
  it('defaults memoryOwnerPid to its own pid and pageCount to a random 2-6 when no opts are given', () => {
    const p = createProcess('solo', 'cpu-bound', [5])
    expect(p.memoryOwnerPid).toBe(p.pid)
    expect(p.pageCount).toBeGreaterThanOrEqual(2)
    expect(p.pageCount).toBeLessThanOrEqual(6)
  })

  it('honors an explicit memoryOwnerPid and pageCount — a thread pointing at its group leader\'s shared allocation', () => {
    const leader = createProcess('leader', 'cpu-bound', [5])
    const thread = createProcess('leader:t2', 'cpu-bound', [5], SHELL_PID, { memoryOwnerPid: leader.pid, pageCount: 4 })
    expect(thread.memoryOwnerPid).toBe(leader.pid)
    expect(thread.memoryOwnerPid).not.toBe(thread.pid)
    expect(thread.pageCount).toBe(4)
  })
})

describe('SchedulerEngine — priority boost reaches I/O-blocked processes too', () => {
  it('resets queueLevel even for a process currently WAITING on I/O', () => {
    const engine = new SchedulerEngine({ quanta: [2, 4, Infinity], boostInterval: 6 })
    const p1 = createProcess('interactive', 'interactive', [5, 10, 3])
    engine.spawn(p1)

    engine.tick()
    engine.tick()
    expect(p1.queueLevel).toBe(1)
    engine.tick()
    engine.tick()
    engine.tick()
    expect(p1.state).toBe('WAITING')
    expect(p1.queueLevel).toBe(1)

    const result = engine.tick()
    expect(result.boosted).toBe(true)
    expect(p1.state).toBe('WAITING')
    expect(p1.queueLevel).toBe(0)
  })
})

describe('SchedulerEngine — bounded process history', () => {
  it('prunes old terminated processes but keeps lifetime metrics exact', () => {
    const engine = new SchedulerEngine({ quanta: [100, 100, Infinity], boostInterval: 0 })
    const total = 20
    for (let i = 0; i < total; i++) {
      engine.spawn(createProcess(`p${i}`, 'cpu-bound', [1]))
    }
    for (let i = 0; i < total; i++) engine.tick()

    expect(engine.getProcesses().length).toBeLessThanOrEqual(15)

    const metrics = engine.getMetrics()
    expect(metrics.completed).toBe(20)
    expect(metrics.avgWaitingTicks).toBeCloseTo((0 + 19) / 2)
    expect(metrics.avgTurnaroundTicks).toBeCloseTo((1 + 20) / 2)
  })
})

describe('createProcess — parentPid', () => {
  it('defaults to INIT_PID, and accepts an explicit parent (e.g. SHELL_PID for `run`)', () => {
    const auto = createProcess('backupd', 'cpu-bound', [5])
    expect(auto.parentPid).toBe(INIT_PID)

    const fromShell = createProcess('compiler', 'cpu-bound', [5], SHELL_PID)
    expect(fromShell.parentPid).toBe(SHELL_PID)
  })
})

describe('SchedulerEngine — malformed (even-length) bursts array', () => {
  it('terminates right after the last I/O burst finishes, without burning a phantom CPU tick', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('odd-input', 'cpu-bound', [1, 1])
    engine.spawn(p1)

    engine.tick()
    expect(p1.state).toBe('WAITING')

    engine.tick()
    expect(p1.state).toBe('TERMINATED')
    expect(p1.finishTick).toBe(2)
    expect(p1.totalBurstTicks).toBe(1)
  })
})

describe('SchedulerEngine — device-owned I/O waits', () => {
  function recordingPort() {
    const submitted: { pid: number; sizeHint: number }[] = []
    return {
      submitted,
      port: {
        submit(pid: number, sizeHint: number) {
          submitted.push({ pid, sizeHint })
          return true
        },
      },
    }
  }

  it('hands the I/O burst to the installed device and does NOT count it down itself', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const { submitted, port } = recordingPort()
    engine.setIoPort(port)

    const p1 = createProcess('interactive', 'interactive', [1, 3, 2])
    engine.spawn(p1)

    engine.tick()
    engine.tick()
    expect(p1.state).toBe('WAITING')
    expect(p1.blockedOn).toBe('device')
    expect(submitted).toEqual([{ pid: p1.pid, sizeHint: 3 }])

    for (let i = 0; i < 20; i++) engine.tick()
    expect(p1.state).toBe('WAITING')
    expect(p1.blockedOn).toBe('device')

    expect(engine.wake(p1.pid, 'device')).toBe(true)
    expect(p1.state).toBe('READY')
    expect(p1.blockedOn).toBeNull()
    expect(p1.burstIndex).toBe(2)
    expect(p1.burstRemaining).toBe(2)
  })

  it('falls back to the self-timed countdown when the device declines the request', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    engine.setIoPort({ submit: () => false })

    const p1 = createProcess('interactive', 'interactive', [1, 2, 1])
    engine.spawn(p1)
    engine.tick()
    engine.tick()
    expect(p1.blockedOn).toBe('io-burst')

    engine.tick()
    engine.tick()
    expect(p1.blockedOn).toBeNull()
    expect(p1.burstIndex).toBe(2)
  })

  it('keeps its queue level across a device wait — a voluntary yield is still never punished (rule 3)', () => {
    const engine = new SchedulerEngine({ quanta: [2, 8, Infinity], boostInterval: 0 })
    engine.setIoPort({ submit: () => true })
    const p1 = createProcess('mixed', 'cpu-bound', [4, 1, 1])
    engine.spawn(p1)
    for (let i = 0; i < 5; i++) engine.tick()
    expect(p1.queueLevel).toBe(1)
    expect(p1.state).toBe('WAITING')

    engine.wake(p1.pid, 'device')
    expect(p1.queueLevel).toBe(1)
    expect(p1.sliceRemaining).toBe(8)
  })

  it('wake() is a no-op for a self-timed wait, an unknown pid, or a runnable process', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('a', 'interactive', [1, 5, 1])
    engine.spawn(p1)
    engine.tick()
    expect(engine.wake(p1.pid, 'device')).toBe(false)
    engine.tick()
    expect(p1.blockedOn).toBe('io-burst')
    expect(engine.wake(p1.pid, 'device')).toBe(false)
    expect(p1.state).toBe('WAITING')
    expect(engine.wake(999, 'device')).toBe(false)
  })

  it('wake() refuses to resolve a wait it is not the owner of', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    engine.setIoPort({ submit: () => true })
    const p1 = createProcess('a', 'interactive', [1, 5, 2])
    engine.spawn(p1)
    engine.tick()
    engine.tick()
    expect(p1.blockedOn).toBe('device')

    expect(engine.wake(p1.pid, 'pipe')).toBe(false)
    expect(p1.blockedOn).toBe('device')
    expect(p1.burstIndex).toBe(1)
  })

  it('a device completion arriving while the process is STOPPED is honoured, but SIGSTOP still holds it', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    engine.setIoPort({ submit: () => true })
    const p1 = createProcess('a', 'interactive', [1, 5, 2])
    engine.spawn(p1)
    engine.tick()
    engine.tick()
    expect(p1.blockedOn).toBe('device')

    engine.stop(p1.pid)
    expect(engine.wake(p1.pid, 'device')).toBe(true)
    expect(p1.state).toBe('STOPPED')
    expect(p1.blockedOn).toBeNull()
    expect(p1.burstIndex).toBe(2)

    expect(engine.cont(p1.pid)?.state).toBe('READY')
  })

  it('blockOn() parks a runnable process on a pipe and wake() returns it at the same queue level', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('writer', 'cpu-bound', [10])
    engine.spawn(p1)
    engine.tick()
    expect(p1.state).toBe('RUNNING')

    expect(engine.blockOn(p1.pid, 'pipe')).toBe(true)
    expect(p1.state).toBe('WAITING')
    expect(p1.blockedOn).toBe('pipe')

    engine.tick()
    expect(engine.getRunning()).toBeUndefined()
    expect(p1.burstRemaining).toBe(9)

    expect(engine.wake(p1.pid, 'pipe')).toBe(true)
    expect(p1.state).toBe('READY')
    expect(p1.burstIndex).toBe(0)
  })

  it('blockOn() refuses a process that is not currently runnable', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    const p1 = createProcess('a', 'cpu-bound', [5])
    engine.spawn(p1)
    expect(engine.blockOn(p1.pid, 'pipe')).toBe(false)

    engine.tick()
    expect(engine.blockOn(p1.pid, 'pipe')).toBe(true)
    expect(engine.blockOn(p1.pid, 'pipe')).toBe(false)
    expect(engine.blockOn(999, 'pipe')).toBe(false)
  })

  it('killing a blocked process clears its wait rather than leaving it in the waiting set', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    engine.setIoPort({ submit: () => true })
    const p1 = createProcess('a', 'interactive', [1, 5, 1])
    engine.spawn(p1)
    engine.tick()
    engine.tick()
    expect(p1.blockedOn).toBe('device')

    engine.kill(p1.pid)
    expect(p1.blockedOn).toBeNull()
    expect(engine.wake(p1.pid, 'device')).toBe(false)
    expect(engine.getBlockedCounts()).toEqual({ 'io-burst': 0, device: 0, pipe: 0 })
  })

  it('getBlockedCounts() reports what each blocked process is actually waiting for', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    engine.setIoPort({ submit: () => true })
    const onDevice = createProcess('io', 'interactive', [1, 5, 1])
    const onPipe = createProcess('pipe', 'cpu-bound', [20])
    engine.spawn(onDevice)
    engine.spawn(onPipe)
    engine.tick()
    engine.tick()
    engine.blockOn(onPipe.pid, 'pipe')

    expect(engine.getBlockedCounts()).toEqual({ 'io-burst': 0, device: 1, pipe: 1 })
  })
})

describe('SchedulerEngine — multiprocessor scheduling', () => {
  function twoCores(balanceInterval = 0) {
    return new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0, coreCount: 2, balanceInterval })
  }

  it('defaults to one core, so a config without coreCount is still plain MLFQ', () => {
    const engine = new SchedulerEngine({ quanta: [4, 8, Infinity], boostInterval: 0 })
    expect(engine.coreCount).toBe(1)
    const p1 = createProcess('a', 'cpu-bound', [5])
    engine.spawn(p1)
    expect(engine.tick().sample.pids).toHaveLength(1)
  })

  it('runs one process per CPU in the same tick', () => {
    const engine = twoCores()
    const p1 = createProcess('a', 'cpu-bound', [10])
    const p2 = createProcess('b', 'cpu-bound', [10])
    engine.spawn(p1)
    engine.spawn(p2)

    const result = engine.tick()
    expect(result.sample.pids).toEqual([p1.pid, p2.pid])
    expect(p1.state).toBe('RUNNING')
    expect(p2.state).toBe('RUNNING')
    expect(p1.burstRemaining).toBe(9)
    expect(p2.burstRemaining).toBe(9)
  })

  it('spreads arrivals across CPUs instead of piling them onto one', () => {
    const engine = twoCores()
    const processes = Array.from({ length: 4 }, (_, i) => createProcess(`p${i}`, 'cpu-bound', [20]))
    for (const p of processes) engine.spawn(p)
    engine.tick()

    const perCore = [0, 1].map((core) => processes.filter((p) => p.core === core).length)
    expect(perCore).toEqual([2, 2])
  })

  it('keeps a process on its own CPU across preemption, demotion and an I/O wait — that is the affinity model', () => {
    const engine = twoCores()
    const p1 = createProcess('a', 'interactive', [2, 3, 2, 3, 2])
    const p2 = createProcess('b', 'cpu-bound', [30])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick()
    const home = p1.core!

    for (let i = 0; i < 40; i++) engine.tick()
    if (p1.state !== 'TERMINATED') expect(p1.core).toBe(home)
  })

  it('a CPU only runs what is in its own queue — a higher-priority process on the other core does not preempt it', () => {
    const engine = twoCores()
    const busy = createProcess('busy', 'cpu-bound', [40])
    engine.spawn(busy)
    engine.tick()
    const busyCore = busy.core!
    const otherCore = busyCore === 0 ? 1 : 0

    const fresh = createProcess('fresh', 'cpu-bound', [10])
    engine.spawn(fresh)
    engine.tick()

    expect(fresh.core).toBe(otherCore)
    expect(engine.getRunning(busyCore)?.pid).toBe(busy.pid)
    expect(engine.getRunning(otherCore)?.pid).toBe(fresh.pid)
  })

  it('never runs the same process on two CPUs at once', () => {
    const engine = twoCores(5)
    for (let i = 0; i < 6; i++) engine.spawn(createProcess(`p${i}`, 'cpu-bound', [40]))

    for (let t = 0; t < 100; t++) {
      const { pids } = engine.tick().sample
      const live = pids.filter((pid): pid is number => pid !== null)
      expect(new Set(live).size).toBe(live.length)
    }
  })

  it('migrates a process off an overloaded CPU once the imbalance is worth it', () => {
    const engine = twoCores(1)
    const processes = Array.from({ length: 4 }, (_, i) => createProcess(`p${i}`, 'cpu-bound', [200]))
    for (const p of processes) engine.spawn(p)
    engine.tick()

    const victims = processes.filter((p) => p.core === 1)
    for (const v of victims) engine.kill(v.pid)
    expect(engine.getMetrics().loadPerCore[1]).toBe(0)

    for (let i = 0; i < 10; i++) engine.tick()
    expect(engine.getMetrics().migrations).toBeGreaterThan(0)
    expect(processes.some((p) => p.state !== 'TERMINATED' && p.core === 1)).toBe(true)
  })

  it('does not migrate for an imbalance of one — that would just swap it back and forth forever', () => {
    const engine = twoCores(1)
    const p1 = createProcess('a', 'cpu-bound', [200])
    const p2 = createProcess('b', 'cpu-bound', [200])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick()
    engine.kill(p2.pid)

    for (let i = 0; i < 20; i++) engine.tick()
    expect(engine.getMetrics().migrations).toBe(0)
    expect(p1.core).toBe(0)
  })

  it('pulls work towards a CPU that has gone idle — the case balancing exists for', () => {
    const engine = twoCores(1)
    const p1 = createProcess('a', 'cpu-bound', [200])
    const p2 = createProcess('b', 'cpu-bound', [200])
    const p3 = createProcess('c', 'cpu-bound', [200])
    for (const p of [p1, p2, p3]) engine.spawn(p)
    engine.tick()
    for (const p of [p1, p2, p3].filter((p) => p.core === 1)) engine.kill(p.pid)
    expect(engine.getMetrics().loadPerCore[1]).toBe(0)

    for (let i = 0; i < 5; i++) engine.tick()
    expect(engine.getMetrics().migrations).toBeGreaterThan(0)
    expect(engine.getMetrics().loadPerCore[1]).toBeGreaterThan(0)
  })

  it('never migrates with balancing switched off, however lopsided things get', () => {
    const engine = twoCores(0)
    const processes = Array.from({ length: 4 }, (_, i) => createProcess(`p${i}`, 'cpu-bound', [200]))
    for (const p of processes) engine.spawn(p)
    engine.tick()
    for (const p of processes.filter((p) => p.core === 1)) engine.kill(p.pid)

    for (let i = 0; i < 50; i++) engine.tick()
    expect(engine.getMetrics().migrations).toBe(0)
  })

  it('measures utilization in core-ticks, so one busy CPU out of two is 50%', () => {
    const engine = twoCores()
    const p1 = createProcess('a', 'cpu-bound', [10])
    engine.spawn(p1)
    for (let i = 0; i < 4; i++) engine.tick()

    expect(engine.getMetrics().cpuUtilization).toBeCloseTo(4 / 8)
  })

  it('boosts within each CPU rather than relocating processes as a side effect', () => {
    const engine = new SchedulerEngine({ quanta: [1, 2, Infinity], boostInterval: 6, coreCount: 2, balanceInterval: 0 })
    const p1 = createProcess('a', 'cpu-bound', [50])
    const p2 = createProcess('b', 'cpu-bound', [50])
    engine.spawn(p1)
    engine.spawn(p2)
    engine.tick()
    const homes = [p1.core, p2.core]

    let boosted = false
    for (let i = 0; i < 12 && !boosted; i++) boosted = engine.tick().boosted
    expect(boosted).toBe(true)
    expect([p1.core, p2.core]).toEqual(homes)
  })

  it('a killed process is removed from whichever CPU queue holds it, even after a migration', () => {
    const engine = twoCores(1)
    const processes = Array.from({ length: 4 }, (_, i) => createProcess(`p${i}`, 'cpu-bound', [200]))
    for (const p of processes) engine.spawn(p)
    engine.tick()
    for (const p of processes.filter((p) => p.core === 1)) engine.kill(p.pid)
    for (let i = 0; i < 10; i++) engine.tick()

    const survivor = processes.find((p) => p.state !== 'TERMINATED')!
    engine.kill(survivor.pid)
    for (let i = 0; i < 5; i++) {
      const { pids } = engine.tick().sample
      expect(pids).not.toContain(survivor.pid)
    }
  })
})
