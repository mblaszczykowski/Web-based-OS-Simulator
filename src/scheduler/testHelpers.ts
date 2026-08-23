import { SHELL_PID, type Process } from '../shared/types'

export function makeProcess(overrides: Partial<Process> = {}): Process {
  return {
    pid: 1,
    name: 'test',
    kind: 'cpu-bound',
    state: 'READY',
    queueLevel: 0,
    parentPid: SHELL_PID,
    memoryOwnerPid: overrides.pid ?? 1,
    arrivalTick: 0,
    finishTick: null,
    bursts: [5],
    burstIndex: 0,
    burstRemaining: 5,
    sliceRemaining: 4,
    blockedOn: null,
    core: 0,
    totalWaitingTicks: 0,
    totalBurstTicks: 0,
    contextSwitches: 0,
    pageCount: 2,
    ...overrides,
  }
}
