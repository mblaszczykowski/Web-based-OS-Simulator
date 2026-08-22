import { describe, expect, it } from 'vitest'
import { SHELL_PID } from '../shared/types'
import { memory, spawnProcess, spawnThreadGroup, killProcess } from './engines'

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
