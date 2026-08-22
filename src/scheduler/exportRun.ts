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
  /** Fraction of *core*-ticks spent running something — see SchedulerEngine.getMetrics(). */
  cpuUtilization: number
  /** How many times the load balancer moved a process between CPUs — roadmap-v5.md §2.3. */
  migrations?: number
}

export interface RunExportData {
  /** Current simulation tick — stamped into the export so two downloads from the same run are distinguishable. */
  tick: number
  metrics: RunExportMetrics
  /**
   * One entry per tick since boot (or since GANTT_HISTORY_CAP started
   * trimming the oldest ones), each holding what every CPU ran that tick —
   * the pid, or null for an idle core. An array per tick since
   * roadmap-v5.md §2.3 made "the process that ran" ambiguous.
   */
  ganttHistory: (number | null)[][]
  /** Real tick number of ganttHistory[0] — 1 unless the cap has trimmed the front, in which case rows must be numbered from here, not from array index (found by code review: numbering purely by index mislabeled every row once the cap kicked in). */
  startTick: number
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
    ...(data.metrics.migrations === undefined ? [] : [`migrations,${data.metrics.migrations}`]),
    `cpuUtilizationPercent,${(data.metrics.cpuUtilization * 100).toFixed(1)}`,
    '',
  ]
  // One column per CPU, so a multi-core run exports what each core did
  // rather than flattening them into a single misleading "pid" column.
  // Derived from the widest row present, not from the scheduler's current
  // core count, so an export stays self-consistent even if the history
  // somehow spans a change in core count.
  const coreCount = Math.max(1, ...data.ganttHistory.map((row) => row.length))
  lines.push(['tick', ...Array.from({ length: coreCount }, (_, core) => `core${core}`)].join(','))
  data.ganttHistory.forEach((row, i) => {
    const cells = Array.from({ length: coreCount }, (_, core) => row[core] ?? '')
    lines.push([data.startTick + i, ...cells].join(','))
  })
  return lines.join('\n')
}

export function runExportFilename(tick: number): string {
  return `os-sim-run-tick-${tick}.csv`
}
