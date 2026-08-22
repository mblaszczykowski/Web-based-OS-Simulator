import { useEffect, useRef, createRef, type RefObject } from 'react'
import { useState } from 'react'
import { WindowFrame } from '../app/WindowFrame'
import { SyncIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { BoundedBufferPanel } from './BoundedBufferPanel'
import { DeadlockPanel } from './DeadlockPanel'
import { BankerPanel } from './BankerPanel'
import { PipePanel } from './PipePanel'
import { readSharedSessionState, writeSharedSessionState, type SharedSyncTab } from '../app/urlState'

type Tab = SharedSyncTab

/**
 * The tab bar is generated from this list rather than written out button
 * by button. It was four near-identical 12-line JSX blocks plus a parallel
 * hand-maintained `tabRefs` record before the IPC tab (roadmap-v5.md §1.2)
 * made it five — at which point the duplication was the thing most likely
 * to go wrong (an id, an aria-controls and a tabIndex all have to agree per
 * tab, in three separate places).
 */
const TABS: { id: Tab; label: string; subtitle: string; Panel: () => JSX.Element }[] = [
  { id: 'buffer', label: 'Bounded buffer', subtitle: 'bounded buffer', Panel: BoundedBufferPanel },
  { id: 'ipc', label: 'Pipes (IPC)', subtitle: 'anonymous pipes', Panel: PipePanel },
  { id: 'deadlock', label: 'Deadlock detection', subtitle: 'deadlock detection', Panel: DeadlockPanel },
  { id: 'banker', label: "Banker's Algorithm", subtitle: "banker's algorithm", Panel: BankerPanel },
]

// Fills the remaining vertical space below the tab bar exactly like the
// panels' own root `.win-body` already does — needed because that class
// is now one level deeper, inside this tabpanel wrapper.
const TABPANEL_STYLE = { flexGrow: 1, display: 'flex', minHeight: 0 } as const

export function SyncWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command
  // Opens directly to whatever tab a shared session link named — roadmap-v4.md §3.1.
  const [tab, setTab] = useState<Tab>(() => readSharedSessionState().syncTab ?? 'buffer')
  // Created once and keyed by tab id, so the refs stay stable across
  // renders the way the four separate useRef() calls they replace did.
  const tabRefs = useRef<Record<Tab, RefObject<HTMLButtonElement>>>()
  if (!tabRefs.current) {
    tabRefs.current = Object.fromEntries(TABS.map((t) => [t.id, createRef<HTMLButtonElement>()])) as Record<
      Tab,
      RefObject<HTMLButtonElement>
    >
  }
  // Only true when a tab change originated from arrow-key navigation (not
  // a click, which already focuses the button it hits) — see the effect below.
  const shouldFocusTab = useRef(false)

  useEffect(() => {
    if (!shouldFocusTab.current) return
    shouldFocusTab.current = false
    tabRefs.current?.[tab].current?.focus()
  }, [tab])

  /** Every tab change routes through here so the shared session link (roadmap-v4.md §3.1) always reflects what's actually showing. */
  function changeTab(next: Tab) {
    setTab(next)
    writeSharedSessionState({ syncTab: next })
  }

  function handleTabsKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const index = TABS.findIndex((t) => t.id === tab)
    const nextIndex = e.key === 'ArrowRight' ? (index + 1) % TABS.length : (index - 1 + TABS.length) % TABS.length
    shouldFocusTab.current = true
    changeTab(TABS[nextIndex]!.id)
  }

  return (
    <WindowFrame
      id="sync"
      title="Process sync"
      subtitle={TABS.find((t) => t.id === tab)?.subtitle ?? ''}
      accent="var(--accent)"
      icon={<SyncIcon />}
    >
      <div className="win-tabs" role="tablist" aria-label="Sync module demo" onKeyDown={handleTabsKeyDown}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            ref={tabRefs.current![id]}
            type="button"
            id={`sync-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`sync-panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={`win-tab${tab === id ? ' active' : ''}`}
            onClick={() => changeTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {TABS.map(({ id, Panel }) => (
        <div
          key={id}
          id={`sync-panel-${id}`}
          role="tabpanel"
          aria-labelledby={`sync-tab-${id}`}
          hidden={tab !== id}
          style={TABPANEL_STYLE}
        >
          {tab === id && <Panel />}
        </div>
      ))}
    </WindowFrame>
  )
}
