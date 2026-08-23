// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProcessTree } from './ProcessTree'
import { INIT_PID, SHELL_PID } from '../shared/types'
import { makeProcess } from './testHelpers'

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
    const follower1 = makeProcess({ pid: 11, name: 'worker:t2', parentPid: 10, memoryOwnerPid: 10 })
    const follower2 = makeProcess({ pid: 12, name: 'worker:t3', parentPid: 10, memoryOwnerPid: 10 })
    render(<ProcessTree processes={[follower1, follower2]} />)
    await open()

    expect(screen.getByText(/worker:t2/)).toBeInTheDocument()
    expect(screen.getByText(/worker:t3/)).toBeInTheDocument()
  })

  it('does not treat INIT_PID/SHELL_PID themselves as orphaned parents needing a fallback branch', async () => {
    const p = makeProcess({ pid: 20, name: 'solo', parentPid: INIT_PID })
    render(<ProcessTree processes={[p]} />)
    await open()

    expect(screen.getAllByText(/solo/)).toHaveLength(1)
  })
})
