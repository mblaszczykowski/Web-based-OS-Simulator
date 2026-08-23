import { describe, expect, it } from 'vitest'
import { SHELL_PID } from '../shared/types'
import { memory, scheduler, filesystem, pipes, spawnProcess, spawnThreadGroup, spawnPipeline, forkProcess, killProcess, stepSimulation } from './engines'

describe('spawnThreadGroup — lightweight processes', () => {
  it('creates one Process per thread, each independently scheduled but sharing one memoryOwnerPid and pageCount', () => {
    const threads = spawnThreadGroup('worker', 3, SHELL_PID)

    expect(threads).toHaveLength(3)
    const leader = threads[0]!
    for (const t of threads) {
      expect(t.memoryOwnerPid).toBe(leader.pid)
      expect(t.pageCount).toBe(leader.pageCount)
    }
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
    expect(memory.getPageTable(threads[1]!.pid)).toBeUndefined()
    expect(memory.getPageTable(threads[2]!.pid)).toBeUndefined()
  })

  it('does not free shared memory while any thread in the group is still alive', () => {
    const threads = spawnThreadGroup('worker', 3, SHELL_PID)
    const leader = threads[0]!

    killProcess(threads[1]!.pid)
    expect(memory.getPageTable(leader.pid)).toHaveLength(leader.pageCount)

    killProcess(threads[2]!.pid)
    expect(memory.getPageTable(leader.pid)).toHaveLength(leader.pageCount)

    killProcess(leader.pid)
    expect(memory.getPageTable(leader.pid)).toBeUndefined()
  })

  it('order of termination does not matter — memory frees exactly once the group is empty either way', () => {
    const threads = spawnThreadGroup('worker', 2, SHELL_PID)
    const leader = threads[0]!

    killProcess(leader.pid)
    expect(memory.getPageTable(leader.pid)).toHaveLength(leader.pageCount)

    killProcess(threads[1]!.pid)
    expect(memory.getPageTable(leader.pid)).toBeUndefined()
  })

  it('returns an empty array for a non-positive count instead of crashing on a nonexistent leader', () => {
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

describe('real I/O blocking — scheduler ↔ SCAN disk', () => {
  const IO_HEAVY_BURSTS = [1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1]

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
    expect(filesystem.getIoState().pending.some((r) => r.waiterPid === process.pid)).toBe(true)

    const blockedAtIndex = process.burstIndex
    expect(runUntil(() => process.blockedOn !== 'device')).toBe(true)
    expect(process.burstIndex).toBeGreaterThan(blockedAtIndex)

    killProcess(process.pid)
  })

  it('never leaves a process blocked on a request the disk threw away (reset-fs, cross-tab import)', () => {
    const process = spawnIsolated(IO_HEAVY_BURSTS)
    expect(runUntil(() => process.blockedOn === 'device')).toBe(true)

    filesystem.resetToEmpty()
    expect(filesystem.getIoState().pending).toHaveLength(0)

    stepSimulation()
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

describe('kernel pipes — PipeEngine ↔ scheduler', () => {
  function runUntil(done: () => boolean, maxTicks = 400): boolean {
    for (let i = 0; i < maxTicks; i++) {
      if (done()) return true
      stepSimulation()
    }
    return done()
  }

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
    scheduler.stop(reader.pid)

    expect(runUntil(() => writer.blockedOn === 'pipe')).toBe(true)
    expect(writer.state).toBe('WAITING')
    const pipe = pipes.getPipes().find((p) => p.writerPid === writer.pid)!
    expect(pipe.buffer.length).toBe(pipe.capacity)

    scheduler.cont(reader.pid)
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
    const [writer, reader] = pipelineWithBursts([60], [1, 2, 1, 2, 1, 2, 1])
    expect(runUntil(() => reader.blockedOn === 'device', 600)).toBe(true)
    const burstIndexOnDisk = reader.burstIndex

    stepSimulation()
    if (reader.blockedOn === 'device') expect(reader.burstIndex).toBe(burstIndexOnDisk)

    killProcess(writer.pid)
    killProcess(reader.pid)
  })
})

describe('fork — copy-on-write process duplication', () => {
  it('gives the child its own scheduler entry, nested under the parent', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    const child = forkProcess(parent.pid)!

    expect(child).toBeDefined()
    expect(child.pid).not.toBe(parent.pid)
    expect(child.parentPid).toBe(parent.pid)
    expect(child.memoryOwnerPid).toBe(child.pid)
    expect(child.pageCount).toBe(parent.pageCount)

    killProcess(parent.pid)
    killProcess(child.pid)
  })

  it('costs no extra memory at the moment of the fork — the pages are shared, not copied', () => {
    const parent = spawnProcess('compiler', 'cpu-bound', SHELL_PID)
    for (let page = 0; page < parent.pageCount; page++) memory.access(parent.pid, page)
    const usedBefore = memory.getFrames().filter((f) => f.owner !== null).length

    const child = forkProcess(parent.pid)!
    expect(memory.getFrames().filter((f) => f.owner !== null).length).toBe(usedBefore)
    expect(memory.getSharedFrameCount()).toBeGreaterThan(0)

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
    parent.burstIndex = 1
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
    expect(child.bursts).toEqual([5])

    parent.burstIndex = 1
    const second = forkProcess(parent.pid)!
    expect(second.bursts.length).toBeGreaterThan(0)

    killProcess(parent.pid)
    killProcess(child.pid)
    killProcess(second.pid)
  })

  it('refuses to fork a thread, an unknown pid, or a dead process', () => {
    expect(forkProcess(99999)).toBeUndefined()

    const threads = spawnThreadGroup('worker', 2, SHELL_PID)
    expect(forkProcess(threads[1]!.pid)).toBeUndefined()

    const dead = spawnProcess('gone', 'cpu-bound', SHELL_PID)
    killProcess(dead.pid)
    expect(forkProcess(dead.pid)).toBeUndefined()

    for (const t of threads) killProcess(t.pid)
  })
})
