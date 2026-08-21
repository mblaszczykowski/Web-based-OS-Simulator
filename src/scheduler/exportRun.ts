// "Download this run" — roadmap-v3.md §3.2. Explicitly the lowest-value
// item in the roadmap (portfolio polish, teaches nothing about scheduling
// on its own), so kept deliberately small: a pure CSV builder here (easy
// to unit test without touching the DOM) plus a thin, untested
// DOM-side-effecting trigger in app/download.ts, the same
// pure/impure split the rest of this codebase already draws (e.g.
// filesystem/engine.ts vs. filesystem/persistence.ts).

export interface RunExportMetrics {
  completed: number
  avgWaitingTicks: number
  avgTurnaroundTicks: number
  contextSwitches: number
  cpuUtilization: number
}

export interface RunExportData {
  /** Current simulation tick — stamped into the export so two downloads from the same run are distinguishable. */
  tick: number
  metrics: RunExportMetrics
  /** One entry per tick since boot: the pid that ran, or null if the CPU was idle that tick. */
  ganttHistory: (number | null)[]
}

/** Builds a small, human-readable CSV: a metrics summary block, then one row per tick of Gantt history. */
export function buildRunCsv(data: RunExportData): string {
  const lines: string[] = [
    '# OS.SIM scheduler run export',
    `# generated at tick ${data.tick}`,
    'metric,value',
    `completed,${data.metrics.completed}`,
    `avgWaitingTicks,${data.metrics.avgWaitingTicks.toFixed(2)}`,
    `avgTurnaroundTicks,${data.metrics.avgTurnaroundTicks.toFixed(2)}`,
    `contextSwitches,${data.metrics.contextSwitches}`,
    `cpuUtilizationPercent,${(data.metrics.cpuUtilization * 100).toFixed(1)}`,
    '',
    'tick,pid',
  ]
  data.ganttHistory.forEach((pid, i) => lines.push(`${i + 1},${pid ?? ''}`))
  return lines.join('\n')
}

export function runExportFilename(tick: number): string {
  return `os-sim-run-tick-${tick}.csv`
}
