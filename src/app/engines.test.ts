import { describe, expect, it } from 'vitest'
import { SHELL_PID } from '../shared/types'
import { memory, scheduler, filesystem, spawnProcess, spawnThreadGroup, killProcess, stepSimulation } from './engines'

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
  it('parks a process on the disk queue when it blocks, and wakes it when the head services its request', () => {
    const process = spawnProcess('ioer', 'interactive', SHELL_PID)
    // A hand-picked burst sequence: one CPU tick, then I/O. The randomised
    // generator would work too, but this makes the tick count exact.
    process.bursts = [1, 4, 1]
    process.burstRemaining = 1

    let blockedAtTick = -1
    for (let i = 0; i < 60 && blockedAtTick === -1; i++) {
      stepSimulation()
      if (process.blockedOn === 'device') blockedAtTick = i
    }
    expect(blockedAtTick).toBeGreaterThanOrEqual(0)
    expect(process.state).toBe('WAITING')
    // The wait is real: there is a queued request with this pid on it.
    expect(filesystem.getIoState().pending.some((r) => r.waiterPid === process.pid)).toBe(true)

    // The head sweeps at most a full disk-width to reach it, whichever
    // cylinder it happened to land on.
    for (let i = 0; i < 200 && process.blockedOn === 'device'; i++) stepSimulation()
    expect(process.blockedOn).not.toBe('device')
    expect(process.burstIndex).toBeGreaterThanOrEqual(2) // returned past its I/O burst

    killProcess(process.pid)
  })

  it('never leaves a process blocked on a request the disk threw away (reset-fs, cross-tab import)', () => {
    const process = spawnProcess('ioer', 'interactive', SHELL_PID)
    process.bursts = [1, 4, 1]
    process.burstRemaining = 1
    for (let i = 0; i < 60 && process.blockedOn !== 'device'; i++) stepSimulation()
    expect(process.blockedOn).toBe('device')

    // Wipes the disk — and with it the pending queue holding the only
    // event that could ever have released this process.
    filesystem.resetToEmpty()
    expect(filesystem.getIoState().pending).toHaveLength(0)

    stepSimulation()
    expect(process.blockedOn).not.toBe('device')
    expect(scheduler.getBlockedCounts().device).toBe(0)

    killProcess(process.pid)
  })

  it('falls back to a self-timed wait while the disk is crashed, rather than freezing every process until fsck', () => {
    filesystem.crash()
    try {
      const process = spawnProcess('ioer', 'interactive', SHELL_PID)
      process.bursts = [1, 4, 1]
      process.burstRemaining = 1
      for (let i = 0; i < 60 && process.blockedOn === null; i++) stepSimulation()
      expect(process.blockedOn).toBe('io-burst')
      killProcess(process.pid)
    } finally {
      filesystem.fsck()
    }
  })
})
