// @vitest-environment jsdom
//
// Component test for a bug found by code review: a thread group's
// followers (roadmap-v4.md §2.1) point parentPid at their leader's pid,
// not at SHELL_PID/INIT_PID directly. If the leader's own Process entry
// later ages out of SchedulerEngine's bounded terminated-process history
// while its followers are still running, the followers used to become
// permanently unreachable in this tree (nothing ever recursed into the
// vanished leader's pid). See ProcessTree.tsx's orphanedParentPids logic.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProcessTree } from './ProcessTree'
import { INIT_PID, SHELL_PID, type Process } from '../shared/types'

function makeProcess(overrides: Partial<Process> = {}): Process {
  return {
    pid: 1,
    name: 'test',
    kind: 'cpu-bound',
    state: 'READY',
    queueLevel: 0,
    parentPid: SHELL_PID,
    memoryOwnerPid: 1,
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

afterEach(() => {
  cleanup()
})

async function open() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Process tree/ }))
}

describe('ProcessTree', () => {
  it('shows a normal process nested under its live parent', async () => {
    const leader = makeProcess({ pid: 10, name: 'leader', parentPid: SHELL_PID })
    const child = makeProcess({ pid: 11, name: 'child', parentPid: 10 })
    render(<ProcessTree processes={[leader, child]} />)
    await open()

    expect(screen.getByText(/leader/)).toBeInTheDocument()
    expect(screen.getByText(/child/)).toBeInTheDocument()
  })

  it('still shows a thread-group follower when its leader has aged out of `processes` entirely', async () => {
    // No Process with pid 10 exists at all — only its two followers, whose
    // parentPid still points at it (exactly what happens once the leader
    // itself terminates and is later pruned from the bounded history).
    const follower1 = makeProcess({ pid: 11, name: 'worker:t2', parentPid: 10 })
    const follower2 = makeProcess({ pid: 12, name: 'worker:t3', parentPid: 10 })
    render(<ProcessTree processes={[follower1, follower2]} />)
    await open()

    expect(screen.getByText(/worker:t2/)).toBeInTheDocument()
    expect(screen.getByText(/worker:t3/)).toBeInTheDocument()
  })

  it('does not treat INIT_PID/SHELL_PID themselves as orphaned parents needing a fallback branch', async () => {
    const p = makeProcess({ pid: 20, name: 'solo', parentPid: INIT_PID })
    render(<ProcessTree processes={[p]} />)
    await open()

    // Exactly one "solo" row — no duplicate orphan-branch rendering of the same process.
    expect(screen.getAllByText(/solo/)).toHaveLength(1)
  })
})
