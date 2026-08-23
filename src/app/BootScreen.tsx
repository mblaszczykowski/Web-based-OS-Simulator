import { useEffect, useState } from 'react'

const BOOT_LINES = [
  'OS.SIM v0.1 booting…',
  'POST: scheduler unit ....... OK',
  'POST: memory management unit ....... OK',
  'POST: disk controller ....... OK',
  'Mounting filesystem…',
  'Starting scheduler…',
  'Starting memory manager…',
  'Initialising sync subsystem…',
  'Welcome.',
]

const LINE_DELAY_MS = 220
export const BOOT_DURATION_MS = LINE_DELAY_MS * BOOT_LINES.length + 250

export function BootScreen() {
  const [shown, setShown] = useState(1)

  useEffect(() => {
    if (shown >= BOOT_LINES.length) return
    const id = window.setTimeout(() => setShown((n) => n + 1), LINE_DELAY_MS)
    return () => window.clearTimeout(id)
  }, [shown])

  return (
    <div className="boot-screen" role="status" aria-live="polite">
      <div className="boot-lines">
        {BOOT_LINES.slice(0, shown).map((line, i) => (
          <div className="boot-line" key={i}>
            <span className="boot-caret">&gt;</span> {line}
          </div>
        ))}
        <span className="boot-cursor" />
      </div>
    </div>
  )
}
