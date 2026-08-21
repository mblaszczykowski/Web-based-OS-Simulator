import { describe, expect, it, vi } from 'vitest'
import { executeCommand, type CommandContext } from './commands'
import { SHELL_PID, type Process } from '../shared/types'

function makeProcess(overrides: Partial<Process> = {}): Process {
  return {
    pid: 1,
    name: 'test',
    kind: 'cpu-bound',
    state: 'READY',
    queueLevel: 0,
    parentPid: SHELL_PID,
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
      swappedPages: 0,
    }),
    fsList: () => ({ ok: true, entries: [] }),
    fsRead: () => ({ ok: false, error: 'not found' }),
    fsCreate: () => ({ ok: true }),
    fsWrite: () => ({ ok: true }),
    fsDelete: () => ({ ok: true }),
    fsMkdir: () => ({ ok: true }),
    fsMove: () => ({ ok: true }),
    fsCopy: () => ({ ok: true }),
    fsCrash: () => {},
    fsFsck: () => ({ replayed: [] }),
    fsCrashed: () => false,
    fsReset: () => {},
    syncStatus: () => ({
      capacity: 6,
      occupancy: 0,
      mutexLocked: false,
      producedTotal: 0,
      consumedTotal: 0,
      corruptionEvents: 0,
      unsafe: false,
    }),
    syncSetUnsafe: () => {},
    networkPing: () => {},
    networkCurl: () => {},
    ...overrides,
  }
}

/** Pull just the text out, for assertions that don't care about error/ok classification. */
function texts(input: string, ctx: CommandContext): string[] {
  return executeCommand(input, ctx).map((l) => l.text)
}

describe('executeCommand', () => {
  it('lists processes for ps with padded columns', () => {
    const ctx = makeContext({
      listProcesses: () => [makeProcess({ pid: 1, name: 'shell', state: 'RUNNING', queueLevel: 0 })],
    })
    const lines = texts('ps', ctx)
    expect(lines[0]).toMatch(/^PID/)
    expect(lines[1]).toContain('shell')
    expect(lines[1]).toContain('RUNNING')
    expect(lines[1]).toContain('Q0')
  })

  it('run spawns a process and echoes its pid', () => {
    const spawnProcess = vi.fn((name: string) => makeProcess({ pid: 42, name }))
    const ctx = makeContext({ spawnProcess })
    const out = executeCommand('run compiler', ctx)
    expect(spawnProcess).toHaveBeenCalledWith('compiler')
    expect(out).toEqual([{ text: 'Started process 42 (compiler).' }])
  })

  it('kill reports success as plain output and failure/misuse as errors', () => {
    const killProcess = vi.fn((pid: number) => pid === 7)
    const ctx = makeContext({ killProcess })
    expect(executeCommand('kill 7', ctx)).toEqual([{ text: 'Process 7 terminated.' }])
    expect(executeCommand('kill 9', ctx)[0]).toMatchObject({ isError: true })
    expect(executeCommand('kill 9', ctx)[0]!.text).toContain('No such process')
    expect(executeCommand('kill', ctx)[0]).toMatchObject({ isError: true })
    expect(executeCommand('kill', ctx)[0]!.text).toContain('usage')
  })

  it('write normalizes a relative path to absolute before calling the fs', () => {
    const fsWrite = vi.fn(() => ({ ok: true as const }))
    const ctx = makeContext({ fsWrite })
    executeCommand('write notes.txt hello world', ctx)
    expect(fsWrite).toHaveBeenCalledWith('/notes.txt', 'hello world')
  })

  it('cat surfaces the filesystem error verbatim, tagged as an error line', () => {
    const ctx = makeContext({ fsRead: () => ({ ok: false, error: 'cat: /x: No such file or directory' }) })
    expect(executeCommand('cat /x', ctx)).toEqual([
      { text: 'cat: /x: No such file or directory', isError: true },
    ])
  })

  it('cat on an empty file prints nothing, not one blank line', () => {
    const ctx = makeContext({ fsRead: () => ({ ok: true, content: '' }) })
    expect(executeCommand('cat /empty.txt', ctx)).toEqual([])
  })

  it('fsck prints one REPLAY line per recovered journal entry, none of them tagged as errors', () => {
    const ctx = makeContext({
      fsFsck: () => ({
        replayed: [
          { id: 1, op: 'write', path: '/a.txt', status: 'committed', tick: 3 },
          { id: 2, op: 'create', path: '/b.txt', status: 'committed', tick: 3 },
        ],
      }),
    })
    const out = executeCommand('fsck', ctx)
    expect(out.every((l) => !l.isError)).toBe(true)
    const lines = out.map((l) => l.text)
    expect(lines).toContain('[REPLAY] write /a.txt → committed')
    expect(lines).toContain('[REPLAY] create /b.txt → committed')
    expect(lines[lines.length - 1]).toBe('[OK] filesystem consistent')
  })

  it('reports an unknown command as an error line', () => {
    expect(executeCommand('frobnicate', makeContext())).toEqual([
      { text: 'command not found: frobnicate', isError: true },
    ])
  })

  it('ignores blank input', () => {
    expect(executeCommand('   ', makeContext())).toEqual([])
  })

  it('touch creates a missing file but no-ops (not an error) if it already exists', () => {
    const fsCreate = vi.fn(() => ({ ok: true as const }))
    const ctx = makeContext({ fsRead: () => ({ ok: false, error: 'nope' }), fsCreate })
    expect(executeCommand('touch new.txt', ctx)).toEqual([{ text: 'Touched /new.txt.' }])
    expect(fsCreate).toHaveBeenCalledWith('/new.txt')

    const ctxExisting = makeContext({ fsRead: () => ({ ok: true, content: 'x' }), fsCreate })
    expect(executeCommand('touch existing.txt', ctxExisting)).toEqual([{ text: 'Touched /existing.txt.' }])
  })

  it('mkdir normalizes the path and surfaces fs errors', () => {
    const fsMkdir = vi.fn(() => ({ ok: false as const, error: 'mkdir: /x: File exists' }))
    const ctx = makeContext({ fsMkdir })
    expect(executeCommand('mkdir x', ctx)).toEqual([{ text: 'mkdir: /x: File exists', isError: true }])
    expect(fsMkdir).toHaveBeenCalledWith('/x')
  })

  it('mv requires both a source and a destination', () => {
    expect(executeCommand('mv a.txt', makeContext())[0]).toMatchObject({ isError: true })
    const fsMove = vi.fn(() => ({ ok: true as const }))
    expect(executeCommand('mv a.txt b.txt', makeContext({ fsMove }))).toEqual([
      { text: 'Moved /a.txt -> /b.txt.' },
    ])
    expect(fsMove).toHaveBeenCalledWith('/a.txt', '/b.txt')
  })

  it('cp requires both a source and a destination', () => {
    expect(executeCommand('cp a.txt', makeContext())[0]).toMatchObject({ isError: true })
    const fsCopy = vi.fn(() => ({ ok: true as const }))
    expect(executeCommand('cp a.txt b.txt', makeContext({ fsCopy }))).toEqual([
      { text: 'Copied /a.txt -> /b.txt.' },
    ])
    expect(fsCopy).toHaveBeenCalledWith('/a.txt', '/b.txt')
  })

  it('ls with a wildcard filters entries by glob', () => {
    const ctx = makeContext({
      fsList: () => ({
        ok: true,
        entries: [
          { name: 'a.txt', type: 'file' },
          { name: 'b.txt', type: 'file' },
          { name: 'readme.md', type: 'file' },
        ],
      }),
    })
    expect(texts('ls *.txt', ctx)).toEqual(['a.txt  b.txt'])
    expect(executeCommand('ls *.zip', ctx)[0]).toMatchObject({ isError: true })
  })

  it('rm with a wildcard deletes every matching file', () => {
    const fsDelete = vi.fn(() => ({ ok: true as const }))
    const ctx = makeContext({
      fsList: () => ({
        ok: true,
        entries: [
          { name: 'a.txt', type: 'file' },
          { name: 'b.txt', type: 'file' },
          { name: 'keep.md', type: 'file' },
        ],
      }),
      fsDelete,
    })
    const out = executeCommand('rm *.txt', ctx)
    expect(fsDelete).toHaveBeenCalledWith('/a.txt')
    expect(fsDelete).toHaveBeenCalledWith('/b.txt')
    expect(fsDelete).not.toHaveBeenCalledWith('/keep.md')
    expect(out).toEqual([{ text: 'Removed /a.txt.' }, { text: 'Removed /b.txt.' }])
  })
})
