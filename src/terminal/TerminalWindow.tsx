import { useEffect, useRef, useState } from 'react'
import type { DirEntry } from '../shared/types'
import { WindowFrame } from '../app/WindowFrame'
import { TerminalIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { filesystem } from '../app/engines'
import { COMMAND_NAMES } from './commands'

// Command history intentionally persists across reload (unlike every other
// piece of simulator state, which resets on refresh — see plan.md §2.5 /
// roadmap.md §1.4): it's harmless, session-scoped convenience, not
// simulated system state.
const HISTORY_KEY = 'ossim.terminal.history'
const HISTORY_LIMIT = 200

function loadHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveHistory(history: string[]): void {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-HISTORY_LIMIT)))
  } catch {
    // localStorage unavailable (private mode / quota) — history just won't persist, not fatal.
  }
}

/** Every absolute path in the tree, directories suffixed with `/` (so completion can tell them apart). */
function collectPaths(node: DirEntry, prefix: string, acc: string[]): void {
  for (const child of node.children ?? []) {
    const path = prefix === '/' ? `/${child.name}` : `${prefix}/${child.name}`
    if (child.type === 'dir') {
      acc.push(`${path}/`)
      collectPaths(child, path, acc)
    } else {
      acc.push(path)
    }
  }
}

/** Rewrites an absolute path onto `cwd`, e.g. ('/home/notes.txt', '/home') -> 'notes.txt'. `null` if it isn't under cwd at all (no '../' support in completion — see roadmap-v3.md §1.1). */
function toRelative(absPath: string, cwd: string): string | null {
  if (cwd === '/') return absPath.slice(1)
  if (absPath.startsWith(`${cwd}/`)) return absPath.slice(cwd.length + 1)
  return null
}

/** Completion candidates for `query`, relative to `cwd` unless `query` is itself absolute (leading `/`) — roadmap-v3.md §1.1. */
function pathCandidates(query: string, cwd: string): string[] {
  const absolute: string[] = []
  collectPaths(filesystem.getTree(), '/', absolute)
  if (query.startsWith('/')) return absolute.filter((p) => p.startsWith(query))
  const relative = absolute.map((p) => toRelative(p, cwd)).filter((p): p is string => p !== null)
  return relative.filter((p) => p.startsWith(query))
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return ''
  return strs.reduce((acc, s) => {
    let i = 0
    while (i < acc.length && i < s.length && acc[i] === s[i]) i++
    return acc.slice(0, i)
  })
}

interface SearchState {
  query: string
  /** Index into `history` of the entry currently shown, or null if `query` matches nothing. */
  matchIndex: number | null
}

/** Most recent entry at or before `fromIndex` (inclusive) containing `query` as a substring — bash/zsh-style reverse-i-search (roadmap-v4.md §1.3). An empty query never matches (nothing to search for yet). */
function findMatch(history: string[], query: string, fromIndex: number): number | null {
  if (!query) return null
  for (let i = Math.min(fromIndex, history.length - 1); i >= 0; i--) {
    if (history[i]!.includes(query)) return i
  }
  return null
}

export function TerminalWindow() {
  const lines = useSimStore((s) => s.terminalLines)
  const runCommand = useSimStore((s) => s.runCommand)
  const cwd = useSimStore((s) => s.cwd)
  const demo = useSimStore((s) => s.demo)
  const lastAnnouncement = useSimStore((s) => s.lastAnnouncement)
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>(() => loadHistory())
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [search, setSearch] = useState<SearchState | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lines])

  function submit() {
    const trimmed = value.trim()
    if (!trimmed) return
    runCommand(trimmed)
    setHistory((h) => {
      const next = [...h, trimmed]
      saveHistory(next)
      return next
    })
    setHistoryIndex(null)
    setValue('')
  }

  function handleTabComplete() {
    const trailingSpace = /\s$/.test(value)
    const parts = value.split(/\s+/).filter(Boolean)
    const completingCommand = parts.length === 0 || (parts.length === 1 && !trailingSpace)
    const current = trailingSpace ? '' : (parts[parts.length - 1] ?? '')

    const candidates = completingCommand
      ? COMMAND_NAMES.filter((c) => c.startsWith(current))
      : pathCandidates(current, cwd)
    if (candidates.length === 0) return

    const completion = candidates.length === 1 ? candidates[0]! : longestCommonPrefix(candidates)
    if (!completion || completion === current) return

    const prefixParts = trailingSpace ? parts : parts.slice(0, -1)
    const trailer = candidates.length === 1 && completingCommand ? ' ' : ''
    setValue([...prefixParts, completion].join(' ') + trailer)
  }

  /** Re-runs the search for `query` and mirrors the match (or '') into the normal input buffer, so Enter can just reuse submit(). */
  function updateSearch(query: string, fromIndex: number) {
    const matchIndex = findMatch(history, query, fromIndex)
    setSearch({ query, matchIndex })
    setValue(matchIndex !== null ? history[matchIndex]! : '')
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>, current: SearchState) {
    e.preventDefault()
    if (e.key === 'Escape') {
      setSearch(null)
      setValue('')
    } else if (e.key === 'Enter') {
      if (current.matchIndex === null) return // nothing matched — stay in search rather than submit a blank line
      setSearch(null)
      submit()
    } else if (e.key === 'Backspace') {
      updateSearch(current.query.slice(0, -1), history.length - 1)
    } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      updateSearch(current.query + e.key, history.length - 1)
    }
    // Any other key (Shift, arrows, etc.) while searching is swallowed — see the unconditional preventDefault above.
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (demo.active) return // input is read-only during the scripted demo — ignore stray keystrokes/Enter

    if (e.ctrlKey && e.key === 'r') {
      e.preventDefault()
      if (search === null) {
        setSearch({ query: '', matchIndex: null })
        setValue('')
      } else {
        // Ctrl+R again with the same query: step to the next older match.
        updateSearch(search.query, (search.matchIndex ?? history.length) - 1)
      }
      return
    }

    if (search !== null) {
      handleSearchKeyDown(e, search)
      return
    }

    if (e.key === 'Enter') {
      submit()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      handleTabComplete()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (history.length === 0) return
      const next = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1)
      setHistoryIndex(next)
      setValue(history[next]!)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (historyIndex === null) return
      const next = historyIndex + 1
      if (next >= history.length) {
        setHistoryIndex(null)
        setValue('')
      } else {
        setHistoryIndex(next)
        setValue(history[next]!)
      }
    }
  }

  return (
    <WindowFrame
      id="terminal"
      title="Terminal"
      subtitle={demo.active ? 'auto-demo running…' : undefined}
      accent="var(--accent)"
      icon={<TerminalIcon />}
    >
      <div className="term-body" onClick={() => inputRef.current?.focus()}>
        <div className="term-scroll" ref={scrollRef}>
          {lines.map((line) => (
            <div className="term-line" key={line.id}>
              {line.kind === 'prompt' ? (
                <>
                  <span className="term-user">guest@os-sim</span>
                  <span className="term-muted">:{line.cwd ?? '/'}$</span> <span className="term-cmd">{line.text}</span>
                </>
              ) : (
                <span className={line.kind === 'error' ? 'term-error' : 'term-output'}>{line.text}</span>
              )}
            </div>
          ))}
        </div>
        {/*
          Announces the full result of the most recently run command —
          not just whichever line happened to render last, since commands
          like `ps`/`top`/`fsck` routinely produce several lines at once.
        */}
        <div className="visually-hidden" aria-live="polite" aria-atomic="true">
          {lastAnnouncement}
        </div>
        <div className="term-input-row">
          {search !== null ? (
            <span className="term-muted">
              ({search.matchIndex === null && search.query ? 'failed ' : ''}reverse-i-search)`{search.query}':
            </span>
          ) : (
            <>
              <span className="term-user">guest@os-sim</span>
              <span className="term-muted">:{cwd}$</span>
            </>
          )}
          <input
            ref={inputRef}
            id="terminal-input"
            className="term-input"
            value={demo.active ? demo.typedText : value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            readOnly={demo.active}
            spellCheck={false}
            autoFocus
            aria-label={search !== null ? 'Reverse history search' : 'Terminal input'}
          />
          <span className="term-cursor" />
        </div>
      </div>
    </WindowFrame>
  )
}
