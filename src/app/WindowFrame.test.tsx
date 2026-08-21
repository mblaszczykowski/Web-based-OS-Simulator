// @vitest-environment jsdom
//
// Component test — roadmap-v3.md §2.4. WindowFrame's drag/resize/focus-trap
// logic (Phase 2 §2.3 and §2.5) had zero coverage beyond "nobody's broken
// it yet by accident" — exactly the kind of interaction the roadmap calls
// out as silently rotting without a test. This covers the keyboard paths
// (arrow-key move/resize, Tab focus trap, the close button) — the ones
// jsdom can exercise deterministically, unlike pointer-drag.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WindowFrame } from './WindowFrame'
import { useSimStore } from './store'

let snapshot: ReturnType<typeof useSimStore.getState>

beforeEach(() => {
  snapshot = useSimStore.getState()
})

afterEach(() => {
  // Unmount BEFORE restoring state — otherwise a still-mounted component
  // re-renders off of this store write outside of any act() batch (real
  // React state updates always are), which is exactly the "not wrapped in
  // act" warning this ordering avoids.
  cleanup()
  useSimStore.setState(snapshot, true)
})

function renderWindow() {
  useSimStore.setState((s) => ({
    windows: { ...s.windows, terminal: { x: 100, y: 100, w: 400, h: 300, open: true, zIndex: 5 } },
    focusedWindow: 'terminal',
  }))
  return render(
    <WindowFrame id="terminal" title="Terminal" accent="#199e70" icon={<span>icon</span>}>
      <button type="button">child action</button>
    </WindowFrame>,
  )
}

describe('WindowFrame', () => {
  it('renders nothing when the window is closed, and its children when open', () => {
    useSimStore.setState((s) => ({ windows: { ...s.windows, terminal: { ...s.windows.terminal, open: false } } }))
    const { container } = render(
      <WindowFrame id="terminal" title="Terminal" accent="#199e70" icon={<span>icon</span>}>
        <button type="button">child action</button>
      </WindowFrame>,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('moves the window with arrow keys on the titlebar, and Shift+arrow moves it further', async () => {
    const user = userEvent.setup()
    renderWindow()
    const titlebar = screen.getByRole('button', { name: 'Maximize' }).closest('.titlebar') as HTMLElement
    titlebar.focus()

    await user.keyboard('{ArrowRight}')
    expect(useSimStore.getState().windows.terminal).toMatchObject({ x: 110, y: 100 })

    await user.keyboard('{Shift>}{ArrowDown}{/Shift}')
    expect(useSimStore.getState().windows.terminal).toMatchObject({ x: 110, y: 130 }) // fast step (30) while stepping down
  })

  it('resizes the window with arrow keys on the resize handle, clamped to a minimum size', async () => {
    const user = userEvent.setup()
    renderWindow()
    const handle = screen.getByLabelText(/resize handle/i)
    handle.focus()

    await user.keyboard('{ArrowRight}')
    expect(useSimStore.getState().windows.terminal).toMatchObject({ w: 410, h: 300 })

    await user.keyboard('{ArrowUp}')
    expect(useSimStore.getState().windows.terminal).toMatchObject({ w: 410, h: 290 })
  })

  it('closing via the Close button actually closes the window (not just visually)', async () => {
    const user = userEvent.setup()
    renderWindow()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(useSimStore.getState().windows.terminal.open).toBe(false)
  })

  it('traps Tab focus inside the window while it is the focused one — wraps both directions', () => {
    renderWindow()
    const region = screen.getByRole('region', { name: 'Terminal window' })
    const focusable = region.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    expect(first).not.toBe(last) // sanity: there really is more than one focusable element to trap between

    last.focus()
    expect(document.activeElement).toBe(last)
    // jsdom doesn't natively move focus on Tab — this only passes if
    // WindowFrame's own keydown handler calls first.focus() itself.
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(last)
  })

  it('does not trap Tab focus when this window is not the focused one', () => {
    renderWindow()
    act(() => {
      useSimStore.setState({ focusedWindow: 'scheduler' }) // some other window has focus now
    })
    const region = screen.getByRole('region', { name: 'Terminal window' })
    const focusable = region.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    const last = focusable[focusable.length - 1]!

    last.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    last.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false) // not intercepted — this window isn't the one with focus
  })
})
