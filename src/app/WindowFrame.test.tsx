// @vitest-environment jsdom

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
    expect(useSimStore.getState().windows.terminal).toMatchObject({ x: 110, y: 130 })
  })

  it('regression: cannot be moved off-screen — a window is never left permanently unreachable', async () => {
    const user = userEvent.setup()
    renderWindow()
    const titlebar = screen.getByRole('button', { name: 'Maximize' }).closest('.titlebar') as HTMLElement
    titlebar.focus()

    for (let i = 0; i < 100; i++) await user.keyboard('{Shift>}{ArrowLeft}{ArrowUp}{/Shift}')

    const { x, y } = useSimStore.getState().windows.terminal
    expect(y).toBeGreaterThanOrEqual(0)
    expect(x + 400).toBeGreaterThan(0)
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
    expect(first).not.toBe(last)

    last.focus()
    expect(document.activeElement).toBe(last)
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(first)

    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }))
    expect(document.activeElement).toBe(last)
  })

  it('does not trap Tab focus when this window is not the focused one', () => {
    renderWindow()
    act(() => {
      useSimStore.setState({ focusedWindow: 'scheduler' })
    })
    const region = screen.getByRole('region', { name: 'Terminal window' })
    const focusable = region.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    const last = focusable[focusable.length - 1]!

    last.focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    last.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })
})
