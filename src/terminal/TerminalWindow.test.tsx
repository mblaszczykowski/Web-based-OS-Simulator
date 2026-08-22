// @vitest-environment jsdom
//
// Component test — roadmap-v3.md §2.4. Covers the terminal's actual React
// wiring (typing, submit, history, tab-completion) rather than just the
// pure command parser (commands.test.ts already covers that in isolation)
// — the seam roadmap-v3.md calls out as having zero coverage today.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalWindow } from './TerminalWindow'
import { useSimStore } from '../app/store'

let snapshot: ReturnType<typeof useSimStore.getState>

beforeEach(() => {
  snapshot = useSimStore.getState()
  window.localStorage.clear() // command history is seeded from here on mount (roadmap-v3.md §1.4's sibling feature)
})

afterEach(() => {
  // Unmount BEFORE restoring state — see the identical note in WindowFrame.test.tsx.
  cleanup()
  useSimStore.setState(snapshot, true)
})

function getInput() {
  return screen.getByLabelText('Terminal input') as HTMLInputElement
}

describe('TerminalWindow', () => {
  it('typing a command and pressing Enter renders it as a prompt line and shows its output', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)

    await user.type(getInput(), 'help')
    await user.keyboard('{Enter}')

    expect(screen.getByText('help')).toBeInTheDocument() // the echoed prompt
    expect(screen.getByText('Available commands:')).toBeInTheDocument() // its output
    expect(getInput()).toHaveValue('') // input cleared after submit
  })

  it('ArrowUp/ArrowDown cycle through submitted command history', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'pwd')
    await user.keyboard('{Enter}')
    await user.type(input, 'help')
    await user.keyboard('{Enter}')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('help') // most recent command first

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('pwd') // then the one before it

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveValue('help')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveValue('') // past the end of history — back to a blank line
  })

  it('Tab completes a unique command-name prefix, with a trailing space', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'he')
    fireEvent.keyDown(input, { key: 'Tab' })

    expect(input).toHaveValue('help ')
  })

  it('Ctrl+R opens reverse-i-search, filters live, and Enter submits the match', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'pwd')
    await user.keyboard('{Enter}')
    await user.type(input, 'help')
    await user.keyboard('{Enter}')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    expect(screen.getByLabelText('Reverse history search')).toBe(input)

    fireEvent.keyDown(input, { key: 'p' })
    expect(input).toHaveValue('help') // most recent history entry containing 'p'

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true }) // step to the next older match
    expect(input).toHaveValue('pwd')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByLabelText('Terminal input')).toBe(input) // search closed
    expect(input).toHaveValue('') // and the match was submitted
  })

  it('Ctrl+R with no match shows a failed search and Escape restores the prompt', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'pwd')
    await user.keyboard('{Enter}')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'z' })
    expect(screen.getByText("(failed reverse-i-search)`z':")).toBeInTheDocument()

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByLabelText('Terminal input')).toBe(input)
    expect(input).toHaveValue('')
  })

  it('stepping past the oldest match keeps it displayed instead of blanking the input', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'pwd')
    await user.keyboard('{Enter}')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'p' })
    expect(input).toHaveValue('pwd')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true }) // no older match than 'pwd' — should stay put, not clear
    expect(input).toHaveValue('pwd')
    expect(screen.getByText("(failed reverse-i-search)`p':")).toBeInTheDocument()
  })

  it('Escape restores the not-yet-submitted draft that was showing before Ctrl+R', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'unsaved-draft')
    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(input).toHaveValue('unsaved-draft')
  })

  it('Escape resets history navigation, so a later ArrowUp starts from the most recent entry again', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'aaa')
    await user.keyboard('{Enter}')
    await user.type(input, 'bbb')
    await user.keyboard('{Enter}')
    await user.type(input, 'ccc')
    await user.keyboard('{Enter}')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('bbb') // two steps back from the end

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'Escape' })

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('ccc') // most recent again, not resuming from the stale mid-history position
  })

  it('narrowing the query after stepping to an older match does not jump forward to a newer one', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'cat notes.txt')
    await user.keyboard('{Enter}')
    await user.type(input, 'ls -la home')
    await user.keyboard('{Enter}')
    await user.type(input, 'man ls')
    await user.keyboard('{Enter}')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'l' })
    expect(input).toHaveValue('man ls') // newest entry containing 'l'

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true }) // step to the next older match
    expect(input).toHaveValue('ls -la home')

    fireEvent.keyDown(input, { key: 's' }) // narrow the query to 'ls' — found by code review: this used
    // to always re-search from the newest entry, silently jumping back to 'man ls' and discarding the
    // user's explicit older-match navigation, instead of continuing from where the search already was.
    expect(input).toHaveValue('ls -la home')
  })

  it('echo $VAR for a name never exported, that collides with an inherited Object.prototype member, substitutes to empty', async () => {
    // Found by code review: the env store is a plain object, and a plain
    // `env[name]` lookup at the real store (not this test's own mock
    // context) resolves `$constructor` to Object's constructor function
    // instead of undefined, printing its source text.
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'echo $constructor')
    await user.keyboard('{Enter}')

    expect(screen.queryByText(/native code/)).not.toBeInTheDocument()
    expect(screen.queryByText(/function Object/)).not.toBeInTheDocument()
  })

  it('clear reached via a chained $VAR substitution actually clears the screen', async () => {
    // Found by code review: a previous store-level fast path string-matched
    // the RAW, unsubstituted line against 'clear' before running it, so
    // `export X=clear && $X` never matched and silently never cleared.
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'pwd')
    await user.keyboard('{Enter}')
    expect(screen.getByText('pwd')).toBeInTheDocument() // sanity check: something is on screen first

    await user.type(input, 'export X=clear && $X')
    await user.keyboard('{Enter}')

    expect(screen.queryByText('pwd')).not.toBeInTheDocument()
    expect(screen.queryByText('export X=clear && $X')).not.toBeInTheDocument()
  })
})
