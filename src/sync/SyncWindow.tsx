import { useEffect, useRef } from 'react'
import { WindowFrame } from '../app/WindowFrame'
import { SyncIcon, WarningIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { sync, resetSync } from '../app/engines'
import type { SyncActor } from '../shared/types'

const STATE_LABEL: Record<SyncActor['state'], string> = {
  idle: 'idle',
  'waiting-empty': 'blocked (empty)',
  'waiting-full': 'blocked (full)',
  'waiting-mutex': 'blocked (mutex)',
  'in-critical-section': 'in CS',
}

const STATE_PILL_CLASS: Record<SyncActor['state'], string> = {
  idle: 'pill--ready',
  'waiting-empty': 'pill--waiting',
  'waiting-full': 'pill--waiting',
  'waiting-mutex': 'pill--waiting',
  'in-critical-section': 'pill--cs',
}

function ActorRow({ actor }: { actor: SyncActor }) {
  return (
    <div className="proc-row">
      <span className="dot" style={{ background: actor.role === 'producer' ? 'var(--accent-sync)' : 'var(--accent-terminal)' }} />
      <span className="pid">{actor.role === 'producer' ? 'P' : 'C'}{actor.id}</span>
      <span className="proc-name">{actor.itemsHandled} handled</span>
      <span className={`pill ${STATE_PILL_CLASS[actor.state]}`}>{STATE_LABEL[actor.state]}</span>
    </div>
  )
}

export function SyncWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command
  const logRef = useRef<HTMLDivElement>(null)

  const actors = sync.getActors()
  const producers = actors.filter((a) => a.role === 'producer')
  const consumers = actors.filter((a) => a.role === 'consumer')
  const buffer = sync.getBuffer()
  const { inPtr, outPtr } = sync.getPointers()
  const metrics = sync.getMetrics()
  const log = sync.getLog()

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  return (
    <WindowFrame
      id="sync"
      title="Process sync"
      subtitle="bounded buffer"
      accent="var(--accent-sync)"
      icon={<SyncIcon />}
    >
      <div className="win-body">
        <div className="sched-sidebar">
          <div className="field">
            <span className="label">Mechanism</span>
            <div className="algo-readout">
              <span className="algo-dot" />
              <span className="algo-name">Counting semaphore + mutex</span>
            </div>
            <span className="algo-desc">
              2 producers, 2 consumers share a circular buffer. `empty`/`full` semaphores gate access to slots; a
              mutex protects the slot write/read itself.
            </span>
          </div>

          <div className="stat-pair">
            <div className="stat">
              <span className="label">empty</span>
              <span className="stat-value">{metrics.semEmptyCount}</span>
            </div>
            <div className="stat">
              <span className="label">full</span>
              <span className="stat-value">{metrics.semFullCount}</span>
            </div>
          </div>
          <div className="stat-pair">
            <div className="stat">
              <span className="label">mutex</span>
              <span className="stat-value" style={{ fontSize: 13 }}>
                {metrics.mutexLocked ? 'locked' : 'free'}
              </span>
            </div>
            <div className="stat">
              <span className="label">produced / consumed</span>
              <span className="stat-value" style={{ fontSize: 13 }}>
                {metrics.producedTotal} / {metrics.consumedTotal}
              </span>
            </div>
          </div>

          {metrics.corruptionEvents > 0 && (
            <div className="crash-panel" style={{ borderColor: 'var(--critical)' }}>
              <span className="algo-desc" style={{ color: 'var(--critical)' }}>
                <WarningIcon /> {metrics.corruptionEvents} corruption event(s) — buffer state has diverged. This is
                what the mutex normally prevents.
              </span>
            </div>
          )}

          <button
            type="button"
            className={sync.unsafe ? 'btn-outline' : 'btn-danger'}
            onClick={() => resetSync(!sync.unsafe)}
          >
            <WarningIcon />
            {sync.unsafe ? 'Reset to safe mode' : 'Show race condition'}
          </button>

          <div className="field" style={{ flexGrow: 1, minHeight: 0 }}>
            <span className="label">Producers</span>
            <div className="proc-list">
              {producers.map((a) => (
                <ActorRow actor={a} key={a.id} />
              ))}
            </div>
            <span className="label" style={{ marginTop: 8 }}>
              Consumers
            </span>
            <div className="proc-list">
              {consumers.map((a) => (
                <ActorRow actor={a} key={a.id} />
              ))}
            </div>
          </div>
        </div>

        <div className="sched-main">
          <div className="row-between">
            <span className="label">
              Circular buffer &mdash; {metrics.realOccupancy}/{buffer.length} occupied
              {sync.unsafe && <span style={{ color: 'var(--critical)' }}> · UNSAFE MODE</span>}
            </span>
          </div>
          <div className="sync-buffer">
            {buffer.map((item, i) => (
              <div className={`sync-slot${item !== null ? ' filled' : ''}`} key={i}>
                {i === inPtr && <span className="sync-ptr sync-ptr-in">in&darr;</span>}
                {i === outPtr && <span className="sync-ptr sync-ptr-out">out&uarr;</span>}
                {item !== null ? `#${item}` : '·'}
              </div>
            ))}
          </div>

          <div className="field" style={{ flexGrow: 1, minHeight: 0 }}>
            <span className="label">Event log</span>
            <div className="sync-log" ref={logRef}>
              {log.length === 0 && <span className="term-muted">no activity yet</span>}
              {log.map((entry) => (
                <div className={`sync-log-row sync-log-row--${entry.kind}`} key={entry.id}>
                  {entry.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  )
}
