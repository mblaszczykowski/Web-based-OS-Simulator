import { useEffect, useRef, useState, type RefObject } from 'react'
import { WindowFrame } from '../app/WindowFrame'
import { SyncIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { BoundedBufferPanel } from './BoundedBufferPanel'
import { DeadlockPanel } from './DeadlockPanel'
import { BankerPanel } from './BankerPanel'

type Tab = 'buffer' | 'deadlock' | 'banker'

const TABS: { id: Tab; label: string }[] = [
  { id: 'buffer', label: 'Bounded buffer' },
  { id: 'deadlock', label: 'Deadlock detection' },
  { id: 'banker', label: "Banker's Algorithm" },
]

// Fills the remaining vertical space below the tab bar exactly like the
// panels' own root `.win-body` already does — needed because that class
// is now one level deeper, inside this tabpanel wrapper.
const TABPANEL_STYLE = { flexGrow: 1, display: 'flex', minHeight: 0 } as const

export function SyncWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command
  const [tab, setTab] = useState<Tab>('buffer')
  const bufferTabRef = useRef<HTMLButtonElement>(null)
  const deadlockTabRef = useRef<HTMLButtonElement>(null)
  const bankerTabRef = useRef<HTMLButtonElement>(null)
  // Only true when a tab change originated from arrow-key navigation (not
  // a click, which already focuses the button it hits) — see the effect below.
  const shouldFocusTab = useRef(false)

  const tabRefs: Record<Tab, RefObject<HTMLButtonElement>> = {
    buffer: bufferTabRef,
    deadlock: deadlockTabRef,
    banker: bankerTabRef,
  }

  useEffect(() => {
    if (!shouldFocusTab.current) return
    shouldFocusTab.current = false
    tabRefs[tab].current?.focus()
    // tabRefs is a fresh object every render but its contents (the refs) are stable — only `tab` should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  function handleTabsKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const index = TABS.findIndex((t) => t.id === tab)
    const nextIndex = e.key === 'ArrowRight' ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length
    shouldFocusTab.current = true
    setTab(TABS[nextIndex]!.id)
  }

  return (
    <WindowFrame
      id="sync"
      title="Process sync"
      subtitle={tab === 'buffer' ? 'bounded buffer' : tab === 'deadlock' ? 'deadlock detection' : "banker's algorithm"}
      accent="var(--accent-sync)"
      icon={<SyncIcon />}
    >
      <div className="win-tabs" role="tablist" aria-label="Sync module demo" onKeyDown={handleTabsKeyDown}>
        <button
          ref={bufferTabRef}
          type="button"
          id="sync-tab-buffer"
          role="tab"
          aria-selected={tab === 'buffer'}
          aria-controls="sync-panel-buffer"
          tabIndex={tab === 'buffer' ? 0 : -1}
          className={`win-tab${tab === 'buffer' ? ' active' : ''}`}
          onClick={() => setTab('buffer')}
        >
          Bounded buffer
        </button>
        <button
          ref={deadlockTabRef}
          type="button"
          id="sync-tab-deadlock"
          role="tab"
          aria-selected={tab === 'deadlock'}
          aria-controls="sync-panel-deadlock"
          tabIndex={tab === 'deadlock' ? 0 : -1}
          className={`win-tab${tab === 'deadlock' ? ' active' : ''}`}
          onClick={() => setTab('deadlock')}
        >
          Deadlock detection
        </button>
        <button
          ref={bankerTabRef}
          type="button"
          id="sync-tab-banker"
          role="tab"
          aria-selected={tab === 'banker'}
          aria-controls="sync-panel-banker"
          tabIndex={tab === 'banker' ? 0 : -1}
          className={`win-tab${tab === 'banker' ? ' active' : ''}`}
          onClick={() => setTab('banker')}
        >
          Banker&rsquo;s Algorithm
        </button>
      </div>
      <div
        id="sync-panel-buffer"
        role="tabpanel"
        aria-labelledby="sync-tab-buffer"
        hidden={tab !== 'buffer'}
        style={TABPANEL_STYLE}
      >
        {tab === 'buffer' && <BoundedBufferPanel />}
      </div>
      <div
        id="sync-panel-deadlock"
        role="tabpanel"
        aria-labelledby="sync-tab-deadlock"
        hidden={tab !== 'deadlock'}
        style={TABPANEL_STYLE}
      >
        {tab === 'deadlock' && <DeadlockPanel />}
      </div>
      <div
        id="sync-panel-banker"
        role="tabpanel"
        aria-labelledby="sync-tab-banker"
        hidden={tab !== 'banker'}
        style={TABPANEL_STYLE}
      >
        {tab === 'banker' && <BankerPanel />}
      </div>
    </WindowFrame>
  )
}
