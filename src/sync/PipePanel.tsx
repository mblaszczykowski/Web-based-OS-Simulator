import { useEffect, useRef } from 'react'
import { pipes, scheduler } from '../app/engines'
import { useSimStore } from '../app/store'
import { colorForPid } from '../app/colors'
import type { PipeState, Process } from '../shared/types'

function endpointState(process: Process | undefined): { label: string; pill: string } {
  if (!process) return { label: 'gone', pill: 'pill--terminated' }
  if (process.state === 'WAITING' && process.blockedOn === 'pipe') return { label: 'blocked (pipe)', pill: 'pill--waiting' }
  if (process.state === 'WAITING') return { label: 'blocked (disk)', pill: 'pill--waiting' }
  if (process.state === 'RUNNING') return { label: 'running', pill: 'pill--running' }
  if (process.state === 'TERMINATED') return { label: 'exited', pill: 'pill--terminated' }
  if (process.state === 'STOPPED') return { label: 'stopped', pill: 'pill--stopped' }
  return { label: 'ready', pill: 'pill--ready' }
}

function EndpointRow({ pid, role, open }: { pid: number; role: 'writer' | 'reader'; open: boolean }) {
  const process = scheduler.getProcess(pid)
  const { label, pill } = open ? endpointState(process) : { label: 'closed', pill: 'pill--terminated' }
  return (
    <div className="proc-row">
      <span className="dot" style={{ background: colorForPid(pid) }} />
      <span className="pid">P{pid}</span>
      <span className="proc-name">
        {role} {process ? `· ${process.name}` : ''}
      </span>
      <span className={`pill ${pill}`}>{label}</span>
    </div>
  )
}

function PipeRow({ pipe }: { pipe: PipeState }) {
  return (
    <div className="field" style={{ marginBottom: 12 }}>
      <span className="label">
        pipe #{pipe.id} &mdash; {pipe.buffer.length}/{pipe.capacity} buffered &middot; {pipe.writtenTotal} written,{' '}
        {pipe.readTotal} read
      </span>
      <div className="sync-buffer">
        {Array.from({ length: pipe.capacity }, (_, i) => {
          const item = pipe.buffer[i]
          return (
            <div className={`sync-slot${item !== undefined ? ' filled' : ''}`} key={i}>
              {item !== undefined ? `#${item}` : '·'}
            </div>
          )
        })}
      </div>
      <div className="proc-list" style={{ marginTop: 6 }}>
        <EndpointRow pid={pipe.writerPid} role="writer" open={pipe.writerOpen} />
        <EndpointRow pid={pipe.readerPid} role="reader" open={pipe.readerOpen} />
      </div>
    </div>
  )
}

export function PipePanel() {
  const logRef = useRef<HTMLDivElement>(null)
  const runCommand = useSimStore((s) => s.runCommand)

  const open = pipes.getPipes()
  const log = pipes.getLog()
  const latestLogId = log.at(-1)?.id

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [latestLogId])

  return (
    <div className="win-body">
      <div className="sched-sidebar">
        <div className="field">
          <span className="label">Mechanism</span>
          <div className="algo-readout">
            <span className="algo-dot" />
            <span className="algo-name">Anonymous pipe</span>
          </div>
          <span className="algo-desc">
            A bounded buffer between two real scheduled processes. The writer blocks when it fills, the reader when it
            empties, and each wakes the other. Both appear in <code>ps</code> and the Gantt chart like any other
            process &mdash; they just spend a lot of their life in WAITING(pipe).
          </span>
        </div>

        <div className="field">
          <span className="algo-desc">
            The shell&rsquo;s <code>|</code> is a different thing: a filter over one command&rsquo;s rendered output,
            with no processes involved. This is the kernel object.
          </span>
        </div>

        <button type="button" className="btn-outline" onClick={() => runCommand('pipe producer consumer')}>
          Start a producer | consumer pipeline
        </button>

        <div className="field" style={{ flexGrow: 1, minHeight: 0 }}>
          <span className="label">Event log</span>
          <div className="sync-log" ref={logRef}>
            {log.length === 0 && <span className="term-muted">no pipe activity yet</span>}
            {log.map((entry) => (
              <div className={`sync-log-row sync-log-row--${entry.kind}`} key={entry.id}>
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="sched-main">
        <div className="row-between">
          <span className="label">Open pipes &mdash; {open.length}</span>
        </div>
        {open.length === 0 ? (
          <span className="term-muted">
            No open pipes. Run <code>pipe producer consumer</code> in the terminal (or use the button) to connect two
            processes.
          </span>
        ) : (
          <div style={{ overflowY: 'auto', minHeight: 0, flexGrow: 1 }}>
            {open.map((pipe) => (
              <PipeRow pipe={pipe} key={pipe.id} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
