import { WindowFrame } from '../app/WindowFrame'
import { SchedulerIcon, PlayIcon, PauseIcon, DownloadIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { scheduler } from '../app/engines'
import { DEFAULT_SCHEDULER_CONFIG } from './engine'
import { colorForPid, labelColorForPid } from '../app/colors'
import { ProcessTree } from './ProcessTree'
import { buildRunCsv, runExportFilename } from './exportRun'
import { downloadTextFile } from '../app/download'

const BLOCK_REASON_LABEL: Record<string, string> = {
  device: 'disk',
  pipe: 'pipe',
  'io-burst': 'io',
}

const STATE_PILL_CLASS: Record<string, string> = {
  RUNNING: 'pill--running',
  READY: 'pill--ready',
  WAITING: 'pill--waiting',
  STOPPED: 'pill--stopped',
  TERMINATED: 'pill--terminated',
  NEW: 'pill--ready',
}

export function SchedulerWindow() {
  useSimStore((s) => s.version)
  const ganttLog = useSimStore((s) => s.ganttLog)
  const ganttHistory = useSimStore((s) => s.ganttHistory)
  const ganttHistoryStartTick = useSimStore((s) => s.ganttHistoryStartTick)
  const tick = useSimStore((s) => s.tick)
  const runCommand = useSimStore((s) => s.runCommand)

  const processes = scheduler.getProcesses()
  const active = processes.filter((p) => p.state !== 'TERMINATED')
  const [q0, q1, q2] = scheduler.getReadyQueues()
  // Capped so they can't wrap; whatever is left out is counted, not dropped.
  const READY_SHOWN = 6
  const LEGEND_SHOWN = 5
  const readyQueue = [...q0, ...q1, ...q2]
  const readyByLevel = readyQueue.slice(0, READY_SHOWN)
  const metrics = scheduler.getMetrics()
  const [quantum0, quantum1] = DEFAULT_SCHEDULER_CONFIG.quanta

  function exportRun() {
    const csv = buildRunCsv({ tick, metrics, ganttHistory, startTick: ganttHistoryStartTick })
    downloadTextFile(runExportFilename(tick), csv)
  }

  return (
    <WindowFrame
      id="scheduler"
      title="Scheduler"
      subtitle={scheduler.coreCount > 1 ? `MLFQ · ${scheduler.coreCount} cores` : 'MLFQ'}
      accent="var(--accent)"
      icon={<SchedulerIcon />}
    >
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

          {/* Per-CPU run-queue depth and the balancer's migration count Hidden on a single-core build, where both
              numbers would say nothing. */}
          {scheduler.coreCount > 1 && (
            <div className="field">
              <span className="label">CPUs &mdash; runnable processes</span>
              <div className="qlevels">
                {metrics.loadPerCore.map((load, core) => (
                  <div className="qlevel" key={core}>
                    <span className="qlevel-name">CPU{core}</span>
                    <span className="qlevel-meta">{load}</span>
                  </div>
                ))}
              </div>
              <span className="algo-desc">
                A process stays on the CPU it was admitted to (affinity); the load balancer moves one across only when
                the imbalance is worth the lost cache. {metrics.migrations} migration(s) so far.
              </span>
            </div>
          )}

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
                  <span
                    className={`pill ${STATE_PILL_CLASS[p.state]}`}
                    title={p.blockedOn ? `blocked on: ${BLOCK_REASON_LABEL[p.blockedOn]}` : undefined}
                  >
                    {p.state}
                    {p.state === 'WAITING' && p.blockedOn ? ` · ${BLOCK_REASON_LABEL[p.blockedOn]}` : ''}
                  </span>
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
                {active.slice(0, LEGEND_SHOWN).map((p) => (
                  <span className="legend-item" key={p.pid}>
                    <span className="dot" style={{ background: colorForPid(p.pid) }} />
                    P{p.pid}
                  </span>
                ))}
                {active.length > LEGEND_SHOWN && (
                  <span className="legend-item term-muted">+{active.length - LEGEND_SHOWN} more</span>
                )}
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
          {/* One row per CPU. With a single core this
              renders exactly as it always did — one unlabelled row — so the
              extra structure costs nothing when there is nothing to show. */}
          {scheduler.cores.map((core) => (
            <div className="gantt-row" key={core}>
              {scheduler.coreCount > 1 && <span className="gantt-core-label">CPU{core}</span>}
              <div className="gantt">
                {ganttLog.length === 0 && <div className="gantt-seg idle" style={{ flex: 1 }} />}
                {ganttLog.map((pids, i) => {
                  const pid = pids[core] ?? null
                  return (
                    <div
                      key={i}
                      className={`gantt-seg${pid === null ? ' idle' : ''}`}
                      style={pid === null ? undefined : { background: colorForPid(pid), color: labelColorForPid(pid) }}
                      title={pid === null ? `CPU${core}: idle` : `CPU${core}: P${pid}`}
                    >
                      {pid !== null && ganttLog.length <= 24 ? `P${pid}` : ''}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}

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
              {readyQueue.length > READY_SHOWN && (
                <span className="term-muted" style={{ fontSize: 11 }}>
                  &hellip; +{readyQueue.length - READY_SHOWN} more
                </span>
              )}
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
