import { useEffect, useRef } from 'react'
import { WindowFrame } from '../app/WindowFrame'
import { TraceIcon } from '../app/icons'
import { useSimStore } from '../app/store'

export function SyscallWindow() {
  const lines = useSimStore((s) => s.syscallLines)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [lines])

  return (
    <WindowFrame
      id="syscalls"
      title="Syscall trace"
      subtitle="fictional, for flavour"
      accent="var(--accent-syscall)"
      icon={<TraceIcon />}
    >
      <div className="win-body column">
        <div className="syscall-panel" ref={scrollRef}>
          {lines.length === 0 && <span className="term-muted">no syscalls yet — run a command in the terminal</span>}
          {lines.map((line) => (
            <div className="syscall-line" key={line.id}>
              {line.text}
            </div>
          ))}
        </div>
      </div>
    </WindowFrame>
  )
}
