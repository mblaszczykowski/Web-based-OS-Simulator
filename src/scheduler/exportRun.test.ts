import { describe, expect, it } from 'vitest'
import { buildRunCsv, runExportFilename } from './exportRun'

describe('buildRunCsv', () => {
  it('emits a metrics summary block followed by one tick,pid row per Gantt sample', () => {
    const csv = buildRunCsv({
      tick: 3,
      metrics: { completed: 2, avgWaitingTicks: 1.5, avgTurnaroundTicks: 4.25, contextSwitches: 1, cpuUtilization: 0.75 },
      ganttHistory: [1, 1, null],
    })
    const lines = csv.split('\n')

    expect(lines).toContain('completed,2')
    expect(lines).toContain('avgWaitingTicks,1.50')
    expect(lines).toContain('avgTurnaroundTicks,4.25')
    expect(lines).toContain('contextSwitches,1')
    expect(lines).toContain('cpuUtilizationPercent,75.0')
    expect(lines).toContain('tick,pid')
    expect(lines).toContain('1,1')
    expect(lines).toContain('2,1')
    expect(lines).toContain('3,') // idle tick — no pid
  })

  it('produces a valid, non-empty export even for a run with no history yet', () => {
    const csv = buildRunCsv({
      tick: 0,
      metrics: { completed: 0, avgWaitingTicks: 0, avgTurnaroundTicks: 0, contextSwitches: 0, cpuUtilization: 0 },
      ganttHistory: [],
    })
    expect(csv).toContain('tick,pid')
    expect(csv.split('\n').at(-1)).toBe('tick,pid') // no trailing rows, but no crash either
  })

  it('names the file after the tick it was generated at', () => {
    expect(runExportFilename(42)).toBe('os-sim-run-tick-42.csv')
  })
})
