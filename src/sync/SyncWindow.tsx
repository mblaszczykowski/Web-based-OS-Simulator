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

const TABS: { id: Tab; label: string; subtitle: string; Panel: () => JSX.Element }[] = [
  { id: 'buffer', label: 'Bounded buffer', subtitle: 'bounded buffer', Panel: BoundedBufferPanel },
  { id: 'ipc', label: 'Pipes (IPC)', subtitle: 'anonymous pipes', Panel: PipePanel },
  { id: 'deadlock', label: 'Deadlock detection', subtitle: 'deadlock detection', Panel: DeadlockPanel },
  { id: 'banker', label: "Banker's Algorithm", subtitle: "banker's algorithm", Panel: BankerPanel },
]

const TABPANEL_STYLE = { flexGrow: 1, display: 'flex', minHeight: 0 } as const

export function SyncWindow() {
  useSimStore((s) => s.version)
  const [tab, setTab] = useState<Tab>(() => readSharedSessionState().syncTab ?? 'buffer')
  const tabRefs = useRef<Record<Tab, RefObject<HTMLButtonElement>>>()
  if (!tabRefs.current) {
    tabRefs.current = Object.fromEntries(TABS.map((t) => [t.id, createRef<HTMLButtonElement>()])) as Record<
      Tab,
      RefObject<HTMLButtonElement>
    >
  }
  const shouldFocusTab = useRef(false)

  useEffect(() => {
    if (!shouldFocusTab.current) return
    shouldFocusTab.current = false
    tabRefs.current?.[tab].current?.focus()
  }, [tab])

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
