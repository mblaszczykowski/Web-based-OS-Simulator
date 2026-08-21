import { describe, expect, it, vi } from 'vitest'
import { executeCommand, type CommandContext } from './commands'
import type { Process } from '../shared/types'

function makeProcess(overrides: Partial<Process> = {}): Process {
  return {
    pid: 1,
    name: 'test',
    kind: 'cpu-bound',
    state: 'READY',
    queueLevel: 0,
    arrivalTick: 0,
    finishTick: null,
    bursts: [5],
    burstIndex: 0,
    burstRemaining: 5,
    sliceRemaining: 4,
    totalWaitingTicks: 0,
    totalBurstTicks: 0,
    contextSwitches: 0,
    pageCount: 2,
    ...overrides,
  }
}

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    listProcesses: () => [],
    spawnProcess: (name) => makeProcess({ name }),
    killProcess: () => true,
    schedulerMetrics: () => ({
      completed: 0,
      avgWaitingTicks: 0,
      avgTurnaroundTicks: 0,
      contextSwitches: 0,
      cpuUtilization: 0,
    }),
    memoryMetrics: () => ({
      pageFaults: 0,
      accesses: 0,
      hitRatio: 0,
      externalFragmentation: 0,
      frameCount: 24,
      usedFrames: 0,
    }),
    fsList: () => ({ ok: true, entries: [] }),
    fsRead: () => ({ ok: false, error: 'not found' }),
    fsWrite: () => ({ ok: true }),
    fsDelete: () => ({ ok: true }),
    fsCrash: () => {},
    fsFsck: () => ({ replayed: [] }),
    fsCrashed: () => false,
    ...overrides,
  }
}

describe('executeCommand', () => {
  it('lists processes for ps with padded columns', () => {
    const ctx = makeContext({
      listProcesses: () => [makeProcess({ pid: 1, name: 'shell', state: 'RUNNING', queueLevel: 0 })],
    })
    const out = executeCommand('ps', ctx)
    expect(out[0]).toMatch(/^PID/)
    expect(out[1]).toContain('shell')
    expect(out[1]).toContain('RUNNING')
    expect(out[1]).toContain('Q0')
  })

  it('run spawns a process and echoes its pid', () => {
    const spawnProcess = vi.fn((name: string) => makeProcess({ pid: 42, name }))
    const ctx = makeContext({ spawnProcess })
    const out = executeCommand('run compiler', ctx)
    expect(spawnProcess).toHaveBeenCalledWith('compiler')
    expect(out[0]).toBe('Started process 42 (compiler).')
  })

  it('kill reports success and failure distinctly', () => {
    const killProcess = vi.fn((pid: number) => pid === 7)
    const ctx = makeContext({ killProcess })
    expect(executeCommand('kill 7', ctx)[0]).toBe('Process 7 terminated.')
    expect(executeCommand('kill 9', ctx)[0]).toContain('No such process')
    expect(executeCommand('kill', ctx)[0]).toContain('usage')
  })

  it('write normalizes a relative path to absolute before calling the fs', () => {
    const fsWrite = vi.fn(() => ({ ok: true as const }))
    const ctx = makeContext({ fsWrite })
    executeCommand('write notes.txt hello world', ctx)
    expect(fsWrite).toHaveBeenCalledWith('/notes.txt', 'hello world')
  })

  it('cat surfaces the filesystem error verbatim', () => {
    const ctx = makeContext({ fsRead: () => ({ ok: false, error: 'cat: /x: No such file or directory' }) })
    expect(executeCommand('cat /x', ctx)).toEqual(['cat: /x: No such file or directory'])
  })

  it('cat on an empty file prints nothing, not one blank line', () => {
    const ctx = makeContext({ fsRead: () => ({ ok: true, content: '' }) })
    expect(executeCommand('cat /empty.txt', ctx)).toEqual([])
  })

  it('fsck prints one REPLAY line per recovered journal entry', () => {
    const ctx = makeContext({
      fsFsck: () => ({
        replayed: [
          { id: 1, op: 'write', path: '/a.txt', status: 'committed', tick: 3 },
          { id: 2, op: 'create', path: '/b.txt', status: 'committed', tick: 3 },
        ],
      }),
    })
    const out = executeCommand('fsck', ctx)
    expect(out).toContain('[REPLAY] write /a.txt → committed')
    expect(out).toContain('[REPLAY] create /b.txt → committed')
    expect(out[out.length - 1]).toBe('[OK] filesystem consistent')
  })

  it('reports an unknown command', () => {
    expect(executeCommand('frobnicate', makeContext())).toEqual(['command not found: frobnicate'])
  })

  it('ignores blank input', () => {
    expect(executeCommand('   ', makeContext())).toEqual([])
  })
})
