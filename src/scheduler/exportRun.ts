export interface RunExportMetrics {
  completed: number
  avgWaitingTicks: number
  avgTurnaroundTicks: number
  contextSwitches: number
  cpuUtilization: number
  migrations?: number
}

export interface RunExportData {
  tick: number
  metrics: RunExportMetrics
  ganttHistory: (number | null)[][]
  startTick: number
}

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
