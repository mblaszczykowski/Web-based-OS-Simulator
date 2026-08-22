// @vitest-environment jsdom
//
// Component test for the shared-session-link wiring (roadmap-v4.md §3.1)
// specifically — does SyncWindow actually read the URL on mount and write
// it back on a tab change? urlState.test.ts already covers the read/write
// functions themselves in isolation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SyncWindow } from './SyncWindow'
import { useSimStore } from '../app/store'

let snapshot: ReturnType<typeof useSimStore.getState>

beforeEach(() => {
  snapshot = useSimStore.getState()
  window.history.replaceState(null, '', '/')
  // Closed by default (see store.ts's WINDOW_DEFAULTS) — force it open so there's something to query.
  useSimStore.setState((s) => ({ windows: { ...s.windows, sync: { ...s.windows.sync, open: true } } }))
})

afterEach(() => {
  cleanup()
  useSimStore.setState(snapshot, true)
  window.history.replaceState(null, '', '/')
})

describe('SyncWindow — shared session link (roadmap-v4.md §3.1)', () => {
  it('defaults to the bounded-buffer tab when the URL names nothing', () => {
    render(<SyncWindow />)
    expect(screen.getByRole('tab', { name: 'Bounded buffer' })).toHaveAttribute('aria-selected', 'true')
  })

  it('opens directly to the tab a shared link named', () => {
    window.history.replaceState(null, '', '/?sync=banker')
    render(<SyncWindow />)
    expect(screen.getByRole('tab', { name: /Banker.s Algorithm/ })).toHaveAttribute('aria-selected', 'true')
  })

  it('ignores an unrecognized sync param and falls back to the default tab', () => {
    window.history.replaceState(null, '', '/?sync=nonsense')
    render(<SyncWindow />)
    expect(screen.getByRole('tab', { name: 'Bounded buffer' })).toHaveAttribute('aria-selected', 'true')
  })

  it('writes the URL when a tab is clicked, so the address bar always matches what is showing', async () => {
    const user = userEvent.setup()
    render(<SyncWindow />)

    await user.click(screen.getByRole('tab', { name: 'Deadlock detection' }))

    expect(new URLSearchParams(window.location.search).get('sync')).toBe('deadlock')
    expect(screen.getByRole('tab', { name: 'Deadlock detection' })).toHaveAttribute('aria-selected', 'true')
  })
})
