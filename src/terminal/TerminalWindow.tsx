import { useEffect, useRef, useState } from 'react'
import { WindowFrame } from '../app/WindowFrame'
import { TerminalIcon } from '../app/icons'
import { useSimStore } from '../app/store'

export function TerminalWindow() {
  const lines = useSimStore((s) => s.terminalLines)
  const runCommand = useSimStore((s) => s.runCommand)
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lines])

  function submit() {
    const trimmed = value.trim()
    if (!trimmed) return
    runCommand(trimmed)
    setHistory((h) => [...h, trimmed])
    setHistoryIndex(null)
    setValue('')
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      submit()
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
    <WindowFrame id="terminal" title="Terminal" accent="var(--accent-terminal)" icon={<TerminalIcon />}>
      <div className="term-body" onClick={() => inputRef.current?.focus()}>
        <div className="term-scroll" ref={scrollRef}>
          {lines.map((line) => (
            <div className="term-line" key={line.id}>
              {line.kind === 'prompt' ? (
                <>
                  <span className="term-user">guest@os-sim</span>
                  <span className="term-muted">:~$</span> <span className="term-cmd">{line.text}</span>
                </>
              ) : (
                <span className={line.kind === 'error' ? 'term-error' : 'term-output'}>{line.text}</span>
              )}
            </div>
          ))}
        </div>
        <div className="term-input-row">
          <span className="term-user">guest@os-sim</span>
          <span className="term-muted">:~$</span>
          <input
            ref={inputRef}
            className="term-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            spellCheck={false}
            autoFocus
            aria-label="Terminal input"
          />
          <span className="term-cursor" />
        </div>
      </div>
    </WindowFrame>
  )
}
