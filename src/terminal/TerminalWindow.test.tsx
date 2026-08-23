// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TerminalWindow } from './TerminalWindow'
import { useSimStore } from '../app/store'

let snapshot: ReturnType<typeof useSimStore.getState>

beforeEach(() => {
  snapshot = useSimStore.getState()
  window.localStorage.clear()
})

afterEach(() => {
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

    expect(screen.getByText('help')).toBeInTheDocument()
    expect(screen.getByText('Available commands:')).toBeInTheDocument()
    expect(getInput()).toHaveValue('')
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
    expect(input).toHaveValue('help')

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('pwd')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveValue('help')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveValue('')
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
    expect(input).toHaveValue('help')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    expect(input).toHaveValue('pwd')

    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByLabelText('Terminal input')).toBe(input)
    expect(input).toHaveValue('')
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

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
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
    expect(input).toHaveValue('bbb')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'Escape' })

    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(input).toHaveValue('ccc')
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
    expect(input).toHaveValue('man ls')

    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    expect(input).toHaveValue('ls -la home')

    fireEvent.keyDown(input, { key: 's' })
    expect(input).toHaveValue('ls -la home')
  })

  it('echo $VAR for a name never exported, that collides with an inherited Object.prototype member, substitutes to empty', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'echo $constructor')
    await user.keyboard('{Enter}')

    expect(screen.queryByText(/native code/)).not.toBeInTheDocument()
    expect(screen.queryByText(/function Object/)).not.toBeInTheDocument()
  })

  it('clear reached via a chained $VAR substitution actually clears the screen', async () => {
    const user = userEvent.setup()
    render(<TerminalWindow />)
    const input = getInput()

    await user.type(input, 'pwd')
    await user.keyboard('{Enter}')
    expect(screen.getByText('pwd')).toBeInTheDocument()

    await user.type(input, 'export X=clear && $X')
    await user.keyboard('{Enter}')

    expect(screen.queryByText('pwd')).not.toBeInTheDocument()
    expect(screen.queryByText('export X=clear && $X')).not.toBeInTheDocument()
  })
})
