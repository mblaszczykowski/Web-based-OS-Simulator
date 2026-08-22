import { SHELL_PID, type Process } from '../shared/types'

/**
 * A minimal but complete `Process` fixture for tests, with every field
 * defaulted to something valid so a test only has to override what it
 * actually cares about. Shared by commands.test.ts and ProcessTree.test.tsx
 * (found by code review: each used to define its own field-for-field
 * duplicate, and both had to be hand-updated in lockstep when
 * `memoryOwnerPid` was added — the exact drift risk a shared fixture exists
 * to avoid).
 */
export function makeProcess(overrides: Partial<Process> = {}): Process {
  return {
    pid: 1,
    name: 'test',
    kind: 'cpu-bound',
    state: 'READY',
    queueLevel: 0,
    parentPid: SHELL_PID,
    // Defaults to this fixture's own (possibly overridden) pid, exactly
    // like the real createProcess() does — an ordinary process owns its
    // own memory. A thread-follower test overrides this explicitly.
    memoryOwnerPid: overrides.pid ?? 1,
    arrivalTick: 0,
    finishTick: null,
    bursts: [5],
    burstIndex: 0,
    burstRemaining: 5,
    sliceRemaining: 4,
    totalWaitingTicks: 0,
    totalBurstTicks: 0,
    contextSwitches: 0,
    pageCount: 2,
    ...overrides,
  }
}
