import { describe, expect, it } from 'vitest'
import { SHELL_PID } from '../shared/types'
import { memory, scheduler, filesystem, pipes, spawnProcess, spawnThreadGroup, spawnPipeline, forkProcess, killProcess, stepSimulation } from './engines'

// roadmap-v4.md §2.1 — lightweight threads: several independently-scheduled
// Process entries sharing exactly one memory allocation. These exercise the
// real singleton engines (the same ones the terminal/UI use), unlike the
// scheduler/memory engine tests which construct their own isolated
// instances — the behavior under test here (freeing shared memory only
// once every thread has terminated) lives in the process:terminated
// subscriber wired in this module, not in either engine alone.
describe('spawnThreadGroup — lightweight processes (roadmap-v4.md §2.1)', () => {
  it('creates one Process per thread, each independently scheduled but sharing one memoryOwnerPid and pageCount', () => {
    const threads = spawnThreadGroup('worker', 3, SHELL_PID)

    expect(threads).toHaveLength(3)
    const leader = threads[0]!
    for (const t of threads) {
      expect(t.memoryOwnerPid).toBe(leader.pid)
      expect(t.pageCount).toBe(leader.pageCount)
    }
    // Independently scheduled: distinct pids, each with its own bursts array instance.
    expect(new Set(threads.map((t) => t.pid)).size).toBe(3)
    expect(threads[0]!.bursts).not.toBe(threads[1]!.bursts)
  })

  it('nests follower threads under the leader (parentPid), not as direct siblings of the spawn point', () => {
    const threads = spawnThreadGroup('worker', 3, SHELL_PID)
    expect(threads[0]!.parentPid).toBe(SHELL_PID)
    expect(threads[1]!.parentPid).toBe(threads[0]!.pid)
    expect(threads[2]!.parentPid).toBe(threads[0]!.pid)
  })

  it('allocates memory exactly once for the whole group', () => {
    const threads = spawnThreadGroup('worker', 3, SHELL_PID)
    const leader = threads[0]!

    expect(memory.getPageTable(leader.pid)).toHaveLength(leader.pageCount)
    // Followers have no allocation of their own — they access the leader's.
    expect(memory.getPageTable(threads[1]!.pid)).toBeUndefined()
    expect(memory.getPageTable(threads[2]!.pid)).toBeUndefined()
  })

  it('does not free shared memory while any thread in the group is still alive', () => {
    const threads = spawnThreadGroup('worker', 3, SHELL_PID)
    const leader = threads[0]!

    killProcess(threads[1]!.pid)
    expect(memory.getPageTable(leader.pid)).toHaveLength(leader.pageCount) // still allocated — 2 siblings alive

    killProcess(threads[2]!.pid)
    expect(memory.getPageTable(leader.pid)).toHaveLength(leader.pageCount) // still allocated — leader itself alive

    killProcess(leader.pid)
    expect(memory.getPageTable(leader.pid)).toBeUndefined() // last thread gone — shared memory freed
  })

  it('order of termination does not matter — memory frees exactly once the group is empty either way', () => {
    const threads = spawnThreadGroup('worker', 2, SHELL_PID)
    const leader = threads[0]!

    killProcess(leader.pid) // kill the leader first this time
    expect(memory.getPageTable(leader.pid)).toHaveLength(leader.pageCount)

    killProcess(threads[1]!.pid)
    expect(memory.getPageTable(leader.pid)).toBeUndefined()
  })

  it('returns an empty array for a non-positive count instead of crashing on a nonexistent leader (found by code review)', () => {
    expect(spawnThreadGroup('worker', 0, SHELL_PID)).toEqual([])
    expect(spawnThreadGroup('worker', -1, SHELL_PID)).toEqual([])
  })
})

describe('spawnProcess — ordinary (non-thread) process, unaffected by thread-group logic', () => {
  it('still frees its own memory immediately on termination, exactly as before', () => {
    const process = spawnProcess('solo', 'cpu-bound', SHELL_PID)
    expect(process.memoryOwnerPid).toBe(process.pid)
    expect(memory.getPageTable(process.pid)).toHaveLength(process.pageCount)

    killProcess(process.pid)
    expect(memory.getPageTable(process.pid)).toBeUndefined()
  })
})

// roadmap-v5.md §1.1 — the wiring that makes a process's I/O burst a real
// request to the disk instead of a number the scheduler counts down alone.
// Like the thread tests above, this exercises the live singletons, because
// the behavior under test is the coordination in this module: neither
// SchedulerEngine nor FilesystemEngine knows the other exists.
describe('real I/O blocking — scheduler ↔ SCAN disk (roadmap-v5.md §1.1)', () => {
  /**
   * Several short CPU bursts separated by I/O. The many I/O bursts are
   * load-bearing, not decoration: stepSimulation() advances the disk in
   * the same call that a process submits its request, so a request landing
   * on a cylinder the head is about to cross is serviced immediately and
   * the process is back to READY before the test can ever observe it in
   * WAITING. That is correct behaviour (a zero-seek hit is a real thing),
   * but it means a single I/O burst gives the assertion below only one
   * chance, which it misses whenever the randomly-chosen cylinder happens
   * to fall within this tick's sweep. Several bursts make that a
   * vanishingly unlikely coincidence instead of a periodic flake.
   */
  const IO_HEAVY_BURSTS = [1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1]

  /**
   * These run against the live singletons, which means the ambient
   * auto-spawned workload (stepSimulation()'s AUTO_SPAWN_INTERVAL) and
   * whatever earlier tests left behind are competing for the CPU. Pausing
   * everything already running, and giving the subject a hand-picked burst
   * sequence, is what keeps "how many ticks until it blocks" a bounded
   * number rather than a coin flip — the same reason every scheduler test
   * states its bursts explicitly.
   */
  function spawnIsolated(bursts: number[]) {
    for (const other of scheduler.getProcesses()) {
      if (other.state !== 'TERMINATED') scheduler.stop(other.pid)
    }
    const process = spawnProcess('ioer', 'interactive', SHELL_PID)
    process.bursts = [...bursts]
    process.burstIndex = 0
    process.burstRemaining = bursts[0]!
    return process
  }

  /** Steps until `done()` or the budget runs out; returns whether it got there. */
  function runUntil(done: () => boolean, maxTicks = 300): boolean {
    for (let i = 0; i < maxTicks; i++) {
      if (done()) return true
      stepSimulation()
    }
    return done()
  }

  it('parks a process on the disk queue when it blocks, and wakes it when the head services its request', () => {
    const process = spawnIsolated(IO_HEAVY_BURSTS)

    expect(runUntil(() => process.blockedOn === 'device')).toBe(true)
    expect(process.state).toBe('WAITING')
    // The wait is real: there is a queued request with this pid on it.
    expect(filesystem.getIoState().pending.some((r) => r.waiterPid === process.pid)).toBe(true)

    // The head sweeps at most a full disk-width to reach it, whichever
    // cylinder it happened to land on.
    const blockedAtIndex = process.burstIndex
    expect(runUntil(() => process.blockedOn !== 'device')).toBe(true)
    expect(process.burstIndex).toBeGreaterThan(blockedAtIndex) // returned past its I/O burst

    killProcess(process.pid)
  })

  it('never leaves a process blocked on a request the disk threw away (reset-fs, cross-tab import)', () => {
    const process = spawnIsolated(IO_HEAVY_BURSTS)
    expect(runUntil(() => process.blockedOn === 'device')).toBe(true)

    // Wipes the disk — and with it the pending queue holding the only
    // event that could ever have released this process.
    filesystem.resetToEmpty()
    expect(filesystem.getIoState().pending).toHaveLength(0)

    stepSimulation()
    // Asserted about this process specifically, not the global blocked
    // count: stepSimulation() runs scheduler.tick() before draining the
    // abandoned waiters, so an unrelated process is free to block on a
    // fresh request during the very same tick.
    expect(process.blockedOn).not.toBe('device')

    killProcess(process.pid)
  })

  it('falls back to a self-timed wait while the disk is crashed, rather than freezing every process until fsck', () => {
    filesystem.crash()
    try {
      const process = spawnIsolated(IO_HEAVY_BURSTS)
      expect(runUntil(() => process.blockedOn !== null)).toBe(true)
      expect(process.blockedOn).toBe('io-burst')
      killProcess(process.pid)
    } finally {
      filesystem.fsck()
    }
  })
})

// roadmap-v5.md §1.2 — the pipe engine decides who should block and who
// should wake; the scheduler is what actually does it. Only this module
// knows both, so only here can the pair be tested end to end.
describe('kernel pipes — PipeEngine ↔ scheduler (roadmap-v5.md §1.2)', () => {
  /** Runs the simulation until `done()` or the budget runs out; returns whether it got there. */
  function runUntil(done: () => boolean, maxTicks = 400): boolean {
    for (let i = 0; i < maxTicks; i++) {
      if (done()) return true
      stepSimulation()
    }
    return done()
  }

  /**
   * spawnPipeline() uses the randomised generateBursts(), which is right
   * for the real thing but useless here: an `interactive` process can be
   * handed as few as four CPU ticks in total, which is exactly the number
   * it takes to fill a PIPE_CAPACITY buffer — so it would sometimes
   * terminate on the very tick it was supposed to block on. These tests
   * assert *which* state a process reaches, so their bursts are stated
   * explicitly, like every other hand-traced test in this repo.
   */
  function pipelineWithBursts(writerBursts: number[], readerBursts: number[]) {
    const [writer, reader] = spawnPipeline('producer', 'consumer', SHELL_PID)
    for (const [process, bursts] of [
      [writer, writerBursts],
      [reader, readerBursts],
    ] as const) {
      process.bursts = [...bursts]
      process.burstIndex = 0
      process.burstRemaining = bursts[0]!
    }
    return [writer, reader] as const
  }

  it('really blocks an endpoint: the writer ends up parked on the pipe, in WAITING(pipe)', () => {
    const [writer, reader] = pipelineWithBursts([60], [60])
    // Starve the reader so only the writer ever runs — it must fill the
    // buffer and then block, rather than writing forever into a buffer
    // that has a bound.
    scheduler.stop(reader.pid)

    expect(runUntil(() => writer.blockedOn === 'pipe')).toBe(true)
    expect(writer.state).toBe('WAITING')
    const pipe = pipes.getPipes().find((p) => p.writerPid === writer.pid)!
    expect(pipe.buffer.length).toBe(pipe.capacity)

    scheduler.cont(reader.pid)
    // The reader draining a slot is what releases the writer — nothing
    // polls, and the writer can't retry on its own while blocked.
    expect(runUntil(() => writer.blockedOn !== 'pipe')).toBe(true)

    killProcess(writer.pid)
    killProcess(reader.pid)
  })

  it('blocks the reader on an empty pipe until the writer produces', () => {
    const [writer, reader] = pipelineWithBursts([60], [60])
    scheduler.stop(writer.pid)

    expect(runUntil(() => reader.blockedOn === 'pipe')).toBe(true)
    scheduler.cont(writer.pid)
    expect(runUntil(() => reader.blockedOn !== 'pipe')).toBe(true)

    killProcess(writer.pid)
    killProcess(reader.pid)
  })

  it('a terminating writer releases a reader parked on the empty pipe, so a pipeline can actually finish', () => {
    const [writer, reader] = pipelineWithBursts([60], [60])
    scheduler.stop(writer.pid)
    expect(runUntil(() => reader.blockedOn === 'pipe')).toBe(true)

    // Without the close-releases-the-counterpart wiring this reader would
    // sit in WAITING forever, waiting for data that can never arrive.
    killProcess(writer.pid)
    expect(reader.blockedOn).toBeNull()
    expect(reader.state).toBe('READY')
    expect(pipes.getPipes().some((p) => p.readerPid === reader.pid && p.writerOpen)).toBe(false)

    killProcess(reader.pid)
  })

  it('a terminating reader releases a writer blocked on the full pipe', () => {
    const [writer, reader] = pipelineWithBursts([60], [60])
    scheduler.stop(reader.pid)
    expect(runUntil(() => writer.blockedOn === 'pipe')).toBe(true)

    killProcess(reader.pid)
    expect(writer.blockedOn).toBeNull()
    killProcess(writer.pid)
  })

  it('items actually flow end to end when both processes are left to run', () => {
    const [writer, reader] = pipelineWithBursts([60], [60])
    const pipeId = pipes.getPipes().find((p) => p.writerPid === writer.pid)!.id
    const readTotal = () => pipes.getPipes().find((p) => p.id === pipeId)?.readTotal ?? 0

    expect(runUntil(() => readTotal() >= 3)).toBe(true)

    killProcess(writer.pid)
    killProcess(reader.pid)
  })

  it('a pipe wake never resolves an unrelated disk wait on the counterpart', () => {
    // The counterpart may well be blocked on the SCAN head rather than the
    // pipe. Waking it as if the pipe had released it would advance it past
    // its I/O burst, silently corrupting its burst sequence — wake() is
    // reason-checked precisely so this can't happen.
    // Short CPU bursts separated by I/O, so the reader reaches a device
    // wait quickly and repeatedly.
    const [writer, reader] = pipelineWithBursts([60], [1, 2, 1, 2, 1, 2, 1])
    expect(runUntil(() => reader.blockedOn === 'device', 600)).toBe(true)
    const burstIndexOnDisk = reader.burstIndex

    stepSimulation()
    if (reader.blockedOn === 'device') expect(reader.burstIndex).toBe(burstIndexOnDisk)

    killProcess(writer.pid)
    killProcess(reader.pid)
  })
})

// roadmap-v5.md §1.3 — fork() is the one place syscallTrace.ts used to
// fabricate outright. These check the coordination this module owns:
// scheduler gets a real child process, memory gets a copy-on-write
// duplicate, and neither engine knows about the other.
describe('fork — copy-on-write process duplication (roadmap-v5.md §1.3)', () => {
  it('gives the child its own scheduler entry, nested under the parent', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    const child = forkProcess(parent.pid)!

    expect(child).toBeDefined()
    expect(child.pid).not.toBe(parent.pid)
    expect(child.parentPid).toBe(parent.pid) // shows nested in ProcessTree, for free
    expect(child.memoryOwnerPid).toBe(child.pid) // its own address space, unlike a thread
    expect(child.pageCount).toBe(parent.pageCount)

    killProcess(parent.pid)
    killProcess(child.pid)
  })

  it('costs no extra memory at the moment of the fork — the pages are shared, not copied', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    // Make some of the parent's pages resident, so there is something to share.
    for (let page = 0; page < parent.pageCount; page++) memory.access(parent.pid, page)
    const usedBefore = memory.getFrames().filter((f) => f.owner !== null).length

    const child = forkProcess(parent.pid)!
    expect(memory.getFrames().filter((f) => f.owner !== null).length).toBe(usedBefore)
    expect(memory.getSharedFrameCount()).toBeGreaterThan(0)

    // ...and the child really does have its own page table pointing at
    // the parent's frames.
    const parentTable = memory.getPageTable(parent.pid)!
    const childTable = memory.getPageTable(child.pid)!
    expect(childTable).not.toBe(parentTable)
    expect(childTable.map((e) => e.frame)).toEqual(parentTable.map((e) => e.frame))

    killProcess(parent.pid)
    killProcess(child.pid)
  })

  it('a write by the child copies the frame and leaves the parent’s alone', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    memory.access(parent.pid, 0)
    const child = forkProcess(parent.pid)!
    const sharedFrame = memory.getPageTable(parent.pid)![0]!.frame

    memory.access(child.pid, 0, true)

    expect(memory.getPageTable(child.pid)![0]!.frame).not.toBe(sharedFrame)
    expect(memory.getPageTable(parent.pid)![0]!.frame).toBe(sharedFrame)
    expect(memory.getMetrics().cowFaults).toBeGreaterThan(0)

    killProcess(parent.pid)
    killProcess(child.pid)
  })

  it('the parent exiting first does not pull shared pages out from under the child', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    for (let page = 0; page < parent.pageCount; page++) memory.access(parent.pid, page)
    const child = forkProcess(parent.pid)!
    const sharedFrames = memory.getPageTable(child.pid)!.map((e) => e.frame).filter((f): f is number => f !== null)
    expect(sharedFrames.length).toBeGreaterThan(0)

    killProcess(parent.pid)

    expect(memory.getPageTable(child.pid)).toBeDefined()
    for (const frameIndex of sharedFrames) {
      expect(memory.getFrames()[frameIndex]!.owner?.pid).toBe(child.pid)
    }
    killProcess(child.pid)
  })

  it('hands the child the parent’s remaining work, always starting on a CPU burst', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    parent.bursts = [5, 3, 4, 3, 6]
    parent.burstIndex = 1 // mid-I/O-burst: the child must start from the next CPU burst
    parent.burstRemaining = 2

    const child = forkProcess(parent.pid)!
    expect(child.bursts).toEqual([4, 3, 6])

    killProcess(parent.pid)
    killProcess(child.pid)
  })

  it('gives a child forked from a process on its last burst a fresh workload rather than an empty one', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    parent.bursts = [5]
    parent.burstIndex = 0
    parent.burstRemaining = 5

    const child = forkProcess(parent.pid)!
    expect(child.bursts).toEqual([5]) // the remaining burst, inherited

    parent.burstIndex = 1 // ran off the end — nothing left to hand over
    const second = forkProcess(parent.pid)!
    expect(second.bursts.length).toBeGreaterThan(0)

    killProcess(parent.pid)
    killProcess(child.pid)
    killProcess(second.pid)
  })

  it('refuses to fork a thread, an unknown pid, or a dead process', () => {
    expect(forkProcess(99999)).toBeUndefined()

    const threads = spawnThreadGroup('worker', 2, SHELL_PID)
    // A follower's address space belongs to its group leader — "fork this
    // one thread" has no unambiguous meaning, so it is refused rather than
    // silently interpreted.
    expect(forkProcess(threads[1]!.pid)).toBeUndefined()

    const dead = spawnProcess('gone', 'cpu-bound', SHELL_PID)
    killProcess(dead.pid)
    expect(forkProcess(dead.pid)).toBeUndefined()

    for (const t of threads) killProcess(t.pid)
  })
})
