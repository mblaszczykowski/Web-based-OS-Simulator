import { WindowFrame } from '../app/WindowFrame'
import { SchedulerIcon, PlayIcon, PauseIcon, DownloadIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { scheduler } from '../app/engines'
import { DEFAULT_SCHEDULER_CONFIG } from './engine'
import { colorForPid, labelColorForPid } from '../app/colors'
import { ProcessTree } from './ProcessTree'
import { buildRunCsv, runExportFilename } from './exportRun'
import { downloadTextFile } from '../app/download'

const STATE_PILL_CLASS: Record<string, string> = {
  RUNNING: 'pill--running',
  READY: 'pill--ready',
  WAITING: 'pill--waiting',
  STOPPED: 'pill--stopped',
  TERMINATED: 'pill--terminated',
  NEW: 'pill--ready',
}

export function SchedulerWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command
  const ganttLog = useSimStore((s) => s.ganttLog)
  const ganttHistory = useSimStore((s) => s.ganttHistory)
  const ganttHistoryStartTick = useSimStore((s) => s.ganttHistoryStartTick)
  const tick = useSimStore((s) => s.tick)
  const runCommand = useSimStore((s) => s.runCommand)

  const processes = scheduler.getProcesses()
  const active = processes.filter((p) => p.state !== 'TERMINATED')
  const [q0, q1, q2] = scheduler.getReadyQueues()
  const readyByLevel = [...q0, ...q1, ...q2].slice(0, 6)
  const metrics = scheduler.getMetrics()
  const [quantum0, quantum1] = DEFAULT_SCHEDULER_CONFIG.quanta

  function exportRun() {
    const csv = buildRunCsv({ tick, metrics, ganttHistory, startTick: ganttHistoryStartTick })
    downloadTextFile(runExportFilename(tick), csv)
  }

  return (
    <WindowFrame id="scheduler" title="Scheduler" subtitle="MLFQ" accent="var(--accent)" icon={<SchedulerIcon />}>
      <div className="win-body">
        <div className="sched-sidebar">
          <div className="field">
            <span className="label">Algorithm</span>
            <div className="algo-readout">
              <span className="algo-dot" />
              <span className="algo-name">MLFQ</span>
            </div>
            <span className="algo-desc">
              New processes enter at Q0. A slice burned without blocking drops one level; blocking for I/O keeps the
              level.
            </span>
          </div>

          <div className="field">
            <span className="label">Queue levels</span>
            <div className="qlevels">
              <div className="qlevel">
                <span className="qlevel-name">Q0</span>
                <span className="qlevel-meta">{quantum0}t</span>
              </div>
              <div className="qlevel">
                <span className="qlevel-name">Q1</span>
                <span className="qlevel-meta">{quantum1}t</span>
              </div>
              <div className="qlevel">
                <span className="qlevel-name">Q2</span>
                <span className="qlevel-meta">FCFS</span>
              </div>
            </div>
          </div>

          <div className="field">
            <span className="label">Process count &mdash; {active.length}</span>
          </div>

          <ProcessTree processes={processes} />

          <div className="field" style={{ flexGrow: 1, minHeight: 0 }}>
            <span className="label">Process list</span>
            <div className="proc-list">
              {processes.length === 0 && <span className="term-muted">no processes yet</span>}
              {processes.map((p) => (
                <div className="proc-row" key={p.pid}>
                  <span className="dot" style={{ background: colorForPid(p.pid) }} />
                  <span className="pid">P{p.pid}</span>
                  <span className="proc-name">{p.name}</span>
                  <span className="qtag">{p.state === 'WAITING' || p.state === 'STOPPED' ? '-' : `Q${p.queueLevel}`}</span>
                  <span className={`pill ${STATE_PILL_CLASS[p.state]}`}>{p.state}</span>
                  {p.state !== 'TERMINATED' && (
                    <button
                      type="button"
                      className="proc-signal-btn"
                      aria-label={p.state === 'STOPPED' ? `Resume process ${p.pid} (SIGCONT)` : `Pause process ${p.pid} (SIGSTOP)`}
                      title={p.state === 'STOPPED' ? 'Resume (SIGCONT)' : 'Pause (SIGSTOP)'}
                      onClick={() => runCommand(p.state === 'STOPPED' ? `kill -CONT ${p.pid}` : `kill -STOP ${p.pid}`)}
                    >
                      {p.state === 'STOPPED' ? <PlayIcon size={11} /> : <PauseIcon size={11} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="sched-main">
          <div className="row-between">
            <span className="label">Live Gantt chart</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="legend">
                {active.slice(0, 5).map((p) => (
                  <span className="legend-item" key={p.pid}>
                    <span className="dot" style={{ background: colorForPid(p.pid) }} />
                    P{p.pid}
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="btn-outline"
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={exportRun}
                title="Download this run's Gantt history and metrics as a CSV file"
              >
                <DownloadIcon size={11} /> Export run
              </button>
            </div>
          </div>
          <div className="gantt">
            {ganttLog.length === 0 && <div className="gantt-seg idle" style={{ flex: 1 }} />}
            {ganttLog.map((pid, i) => (
              <div
                key={i}
                className={`gantt-seg${pid === null ? ' idle' : ''}`}
                style={pid === null ? undefined : { background: colorForPid(pid), color: labelColorForPid(pid) }}
                title={pid === null ? 'idle' : `P${pid}`}
              >
                {pid !== null && ganttLog.length <= 24 ? `P${pid}` : ''}
              </div>
            ))}
          </div>

          <div className="field">
            <span className="label">Ready queue (by level)</span>
            <div className="queue-row">
              {readyByLevel.length === 0 && <span className="term-muted" style={{ fontSize: 11 }}>empty</span>}
              {readyByLevel.map((p, i) => (
                <span key={p.pid} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    className="queue-chip"
                    style={{
                      borderColor: colorForPid(p.pid),
                      color: colorForPid(p.pid),
                      background: `color-mix(in srgb, ${colorForPid(p.pid)} 16%, transparent)`,
                    }}
                  >
                    P{p.pid}
                  </span>
                  {i < readyByLevel.length - 1 && <span className="queue-arrow">&rarr;</span>}
                </span>
              ))}
            </div>
          </div>

          <div className="metrics-grid">
            <div className="stat">
              <span className="label">Avg waiting</span>
              <span className="stat-value">{metrics.avgWaitingTicks.toFixed(1)}t</span>
            </div>
            <div className="stat">
              <span className="label">Avg turnaround</span>
              <span className="stat-value">{metrics.avgTurnaroundTicks.toFixed(1)}t</span>
            </div>
            <div className="stat">
              <span className="label">Ctx switches</span>
              <span className="stat-value">{metrics.contextSwitches}</span>
            </div>
            <div className="stat">
              <span className="label">CPU util</span>
              <span className="stat-value">{Math.round(metrics.cpuUtilization * 100)}%</span>
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  )
}
