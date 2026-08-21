import { useState } from 'react'
import { WindowFrame } from '../app/WindowFrame'
import { SyncIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { BoundedBufferPanel } from './BoundedBufferPanel'
import { DeadlockPanel } from './DeadlockPanel'

type Tab = 'buffer' | 'deadlock'

export function SyncWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command
  const [tab, setTab] = useState<Tab>('buffer')

  return (
    <WindowFrame
      id="sync"
      title="Process sync"
      subtitle={tab === 'buffer' ? 'bounded buffer' : 'deadlock detection'}
      accent="var(--accent-sync)"
      icon={<SyncIcon />}
    >
      <div className="win-tabs" role="tablist" aria-label="Sync module demo">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'buffer'}
          className={`win-tab${tab === 'buffer' ? ' active' : ''}`}
          onClick={() => setTab('buffer')}
        >
          Bounded buffer
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'deadlock'}
          className={`win-tab${tab === 'deadlock' ? ' active' : ''}`}
          onClick={() => setTab('deadlock')}
        >
          Deadlock detection
        </button>
      </div>
      {tab === 'buffer' ? <BoundedBufferPanel /> : <DeadlockPanel />}
    </WindowFrame>
  )
}
