import { describe, expect, it } from 'vitest'
import { buildRunCsv, runExportFilename } from './exportRun'

describe('buildRunCsv', () => {
  it('emits a metrics summary block followed by one row per tick, with a column per CPU', () => {
    const csv = buildRunCsv({
      tick: 3,
      metrics: { completed: 2, avgWaitingTicks: 1.5, avgTurnaroundTicks: 4.25, contextSwitches: 1, cpuUtilization: 0.75 },
      ganttHistory: [[1], [1], [null]],
      startTick: 1,
    })
    const lines = csv.split('\n')

    expect(lines).toContain('completed,2')
    expect(lines).toContain('avgWaitingTicks,1.50')
    expect(lines).toContain('avgTurnaroundTicks,4.25')
    expect(lines).toContain('contextSwitches,1')
    expect(lines).toContain('cpuUtilizationPercent,75.0')
    expect(lines).toContain('tick,core0')
    expect(lines).toContain('1,1')
    expect(lines).toContain('2,1')
    expect(lines).toContain('3,') // idle tick — no pid
  })

  it('gives every CPU its own column rather than flattening a multi-core run', () => {
    const csv = buildRunCsv({
      tick: 3,
      metrics: { completed: 0, avgWaitingTicks: 0, avgTurnaroundTicks: 0, contextSwitches: 0, cpuUtilization: 0.5, migrations: 4 },
      ganttHistory: [
        [1, 2],
        [1, null],
      ],
      startTick: 1,
    })
    const lines = csv.split('\n')
    expect(lines).toContain('tick,core0,core1')
    expect(lines).toContain('1,1,2')
    expect(lines).toContain('2,1,') // CPU1 idle that tick
    expect(lines).toContain('migrations,4')
  })

  it('omits the migrations row entirely for a run that had no balancer', () => {
    const csv = buildRunCsv({
      tick: 1,
      metrics: { completed: 0, avgWaitingTicks: 0, avgTurnaroundTicks: 0, contextSwitches: 0, cpuUtilization: 0 },
      ganttHistory: [[1]],
      startTick: 1,
    })
    expect(csv).not.toContain('migrations')
  })

  it('regression: numbers rows from startTick, not from array index, once history has been trimmed (found by code review)', () => {
    // Simulates a run where GANTT_HISTORY_CAP already trimmed the front —
    // ganttHistory[0] is really tick 10001, not tick 1.
    const csv = buildRunCsv({
      tick: 10003,
      metrics: { completed: 0, avgWaitingTicks: 0, avgTurnaroundTicks: 0, contextSwitches: 0, cpuUtilization: 0 },
      ganttHistory: [[5], [5], [null]],
      startTick: 10001,
    })
    const lines = csv.split('\n')
    expect(lines).toContain('10001,5')
    expect(lines).toContain('10002,5')
    expect(lines).toContain('10003,')
    expect(lines).not.toContain('1,5') // not mislabeled by array position
  })

  it('produces a valid, non-empty export even for a run with no history yet', () => {
    const csv = buildRunCsv({
      tick: 0,
      metrics: { completed: 0, avgWaitingTicks: 0, avgTurnaroundTicks: 0, contextSwitches: 0, cpuUtilization: 0 },
      ganttHistory: [],
      startTick: 1,
    })
    expect(csv).toContain('tick,core0')
    expect(csv.split('\n').at(-1)).toBe('tick,core0') // no trailing rows, but no crash either
  })

  it('names the file after the tick it was generated at', () => {
    expect(runExportFilename(42)).toBe('os-sim-run-tick-42.csv')
  })
})
