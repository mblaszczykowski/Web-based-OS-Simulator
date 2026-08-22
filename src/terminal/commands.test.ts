import { describe, expect, it, vi } from 'vitest'
import { COMMAND_NAMES, executeCommand, type CommandContext } from './commands'
import { SHELL_PID, type Process } from '../shared/types'

function makeProcess(overrides: Partial<Process> = {}): Process {
  return {
    pid: 1,
    name: 'test',
    kind: 'cpu-bound',
    state: 'READY',
    queueLevel: 0,
    parentPid: SHELL_PID,
    memoryOwnerPid: 1,
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
  let cwd = '/'
  const env: Record<string, string> = {}
  return {
    listProcesses: () => [],
    spawnProcess: (name) => makeProcess({ name }),
    spawnStress: (n) => Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1, kind: 'cpu-bound' })),
    spawnThreads: (name, n) =>
      Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1, name: `${name}:t${i + 1}`, memoryOwnerPid: 1 })),
    killProcess: () => true,
    stopProcess: () => true,
    contProcess: () => true,
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
      tlbHitRatio: 0,
      thrashing: false,
    }),
    fsList: () => ({ ok: true, entries: [] }),
    fsRead: () => ({ ok: false, error: 'not found' }),
    fsCreate: () => ({ ok: true }),
    fsWrite: () => ({ ok: true }),
    fsDelete: () => ({ ok: true }),
    fsMkdir: () => ({ ok: true }),
    fsMove: () => ({ ok: true }),
    fsCopy: () => ({ ok: true }),
    fsLink: () => ({ ok: true }),
    fsChmod: () => ({ ok: true }),
    fsCrash: () => {},
    fsFsck: () => ({ replayed: [] }),
    fsCrashed: () => false,
    fsReset: () => {},
    ioMetrics: () => ({
      cylinderCount: 8,
      headPosition: 0,
      pendingCount: 0,
      completedCount: 0,
      avgSeekDistance: 0,
      avgWaitTicks: 0,
    }),
    getCwd: () => cwd,
    setCwd: (path) => {
      cwd = path
    },
    getEnv: (name) => env[name],
    setEnv: (name, value) => {
      env[name] = value
    },
    listEnv: () => env,
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

  it('kill -STOP / -CONT dispatch to stopProcess/contProcess, distinct from a plain terminate', () => {
    const stopProcess = vi.fn(() => true)
    const contProcess = vi.fn(() => true)
    const killProcess = vi.fn(() => true)
    const ctx = makeContext({ stopProcess, contProcess, killProcess })

    expect(executeCommand('kill -STOP 7', ctx)).toEqual([{ text: 'Process 7 stopped (SIGSTOP).' }])
    expect(stopProcess).toHaveBeenCalledWith(7)

    expect(executeCommand('kill -CONT 7', ctx)).toEqual([{ text: 'Process 7 continued (SIGCONT).' }])
    expect(contProcess).toHaveBeenCalledWith(7)

    expect(executeCommand('kill 7', ctx)).toEqual([{ text: 'Process 7 terminated.' }])
    expect(killProcess).toHaveBeenCalledWith(7)
  })

  it('kill -STOP/-CONT report failure the same way a plain kill does', () => {
    const ctx = makeContext({ stopProcess: () => false })
    expect(executeCommand('kill -STOP 9', ctx)[0]).toMatchObject({ isError: true, text: expect.stringContaining('No such process') })
    expect(executeCommand('kill -STOP', ctx)[0]).toMatchObject({ isError: true })
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
    const ctx = makeContext({ fsList: () => ({ ok: true, entries: [] }), fsCreate })
    expect(executeCommand('touch new.txt', ctx)).toEqual([{ text: 'Touched /new.txt.' }])
    expect(fsCreate).toHaveBeenCalledWith('/new.txt')

    const ctxExisting = makeContext({
      fsList: () => ({ ok: true, entries: [{ name: 'existing.txt', type: 'file' }] }),
      fsCreate,
    })
    expect(executeCommand('touch existing.txt', ctxExisting)).toEqual([{ text: 'Touched /existing.txt.' }])
  })

  it('touch no-ops on an existing file even if it is unreadable (permission gates read, not existence)', () => {
    const fsCreate = vi.fn(() => ({ ok: true as const }))
    const ctx = makeContext({
      fsList: () => ({ ok: true, entries: [{ name: 'secret.txt', type: 'file', mode: 0b010 }] }),
      fsRead: () => ({ ok: false, error: 'cat: /secret.txt: Permission denied' }),
      fsCreate,
    })
    expect(executeCommand('touch secret.txt', ctx)).toEqual([{ text: 'Touched /secret.txt.' }])
    expect(fsCreate).not.toHaveBeenCalled()
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

  it('ln requires both a target and a link name, and resolves both against cwd', () => {
    expect(executeCommand('ln a.txt', makeContext())[0]).toMatchObject({ isError: true })
    const fsLink = vi.fn(() => ({ ok: true as const }))
    const ctx = makeContext({ fsLink })
    executeCommand('cd /home', ctx)
    expect(texts('ln a.txt b.txt', ctx)).toEqual(['/home/b.txt => /home/a.txt (hard link).'])
    expect(fsLink).toHaveBeenCalledWith('/home/a.txt', '/home/b.txt')
  })

  it('ln surfaces fs errors verbatim', () => {
    const ctx = makeContext({ fsLink: () => ({ ok: false, error: 'ln: /b.txt: already exists' }) })
    expect(executeCommand('ln a.txt b.txt', ctx)).toEqual([{ text: 'ln: /b.txt: already exists', isError: true }])
  })

  describe('chmod / ls -l (roadmap-v3.md §2.3)', () => {
    it('accepts 1 or 3 octal digits, using only the leftmost as the effective mode', () => {
      const fsChmod = vi.fn(() => ({ ok: true as const }))
      const ctx = makeContext({ fsChmod })
      executeCommand('chmod 4 a.txt', ctx)
      expect(fsChmod).toHaveBeenCalledWith('/a.txt', 4)
      executeCommand('chmod 644 b.txt', ctx)
      expect(fsChmod).toHaveBeenCalledWith('/b.txt', 6)
    })

    it('rejects a malformed mode or a missing argument', () => {
      expect(executeCommand('chmod 8 a.txt', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('chmod rw a.txt', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('chmod 6', makeContext())[0]).toMatchObject({ isError: true })
    })

    it('surfaces fs errors verbatim', () => {
      const ctx = makeContext({ fsChmod: () => ({ ok: false, error: 'chmod: /a.txt: Is a directory' }) })
      expect(executeCommand('chmod 6 a.txt', ctx)).toEqual([{ text: 'chmod: /a.txt: Is a directory', isError: true }])
    })

    it('ls -l shows one row per entry with a real rwx string and size, directories always rwx', () => {
      const ctx = makeContext({
        fsList: () => ({
          ok: true,
          entries: [
            { name: 'secret.txt', type: 'file', mode: 0b100, size: 12 },
            { name: 'notes.txt', type: 'file', mode: 0b110, size: 5 },
            { name: 'sub', type: 'dir' },
          ],
        }),
      })
      const lines = texts('ls -l', ctx)
      expect(lines).toEqual([
        '-r--      12  secret.txt',
        '-rw-       5  notes.txt',
        'drwx       0  sub/',
      ])
    })
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

  it('rm with a literal "?" in the pattern only matches files that actually contain one (found by code review)', () => {
    const fsDelete = vi.fn(() => ({ ok: true as const }))
    const ctx = makeContext({
      fsList: () => ({
        ok: true,
        entries: [
          { name: 'log?.txt', type: 'file' },
          { name: 'logs.txt', type: 'file' },
        ],
      }),
      fsDelete,
    })
    executeCommand('rm log?.txt', ctx)
    expect(fsDelete).toHaveBeenCalledWith('/log?.txt')
    expect(fsDelete).not.toHaveBeenCalledWith('/logs.txt')
  })

  describe('working directory (roadmap-v3.md §1.1)', () => {
    it('cd with no argument goes to root', () => {
      const ctx = makeContext()
      executeCommand('cd /home', ctx)
      expect(ctx.getCwd()).toBe('/home')
      executeCommand('cd', ctx)
      expect(ctx.getCwd()).toBe('/')
    })

    it('cd resolves .. and . relative to cwd, and rejects a target the fs says does not exist', () => {
      const ctx = makeContext()
      executeCommand('cd /home/guest', ctx)
      executeCommand('cd ..', ctx)
      expect(ctx.getCwd()).toBe('/home')
      executeCommand('cd ./guest', ctx)
      expect(ctx.getCwd()).toBe('/home/guest')

      const failing = makeContext({ fsList: () => ({ ok: false, error: 'no such dir' }) })
      const result = executeCommand('cd nope', failing)
      expect(result[0]).toMatchObject({ isError: true })
      expect(failing.getCwd()).toBe('/') // rejected — cwd unchanged
    })

    it('pwd prints the current working directory', () => {
      const ctx = makeContext()
      executeCommand('cd /var/log', ctx)
      expect(texts('pwd', ctx)).toEqual(['/var/log'])
    })

    it('regression: reset-fs also resets cwd to root, since the wiped disk only has root (found by code review)', () => {
      const ctx = makeContext()
      executeCommand('cd /home/guest', ctx)
      expect(ctx.getCwd()).toBe('/home/guest')
      executeCommand('reset-fs', ctx)
      expect(ctx.getCwd()).toBe('/')
    })

    it('resolves relative file arguments against cwd, leaving absolute ones untouched', () => {
      const fsRead = vi.fn(() => ({ ok: true as const, content: 'hi' }))
      const ctx = makeContext({ fsRead })
      executeCommand('cd /home', ctx)
      executeCommand('cat notes.txt', ctx)
      expect(fsRead).toHaveBeenCalledWith('/home/notes.txt')
      executeCommand('cat /etc/motd', ctx)
      expect(fsRead).toHaveBeenCalledWith('/etc/motd')
    })

    it('ls with no argument lists cwd, not always root', () => {
      const fsList = vi.fn(() => ({ ok: true as const, entries: [] }))
      const ctx = makeContext({ fsList })
      executeCommand('cd /home', ctx)
      executeCommand('ls', ctx)
      expect(fsList).toHaveBeenCalledWith('/home')
    })
  })

  describe('command chaining (roadmap-v3.md §1.2)', () => {
    it('; runs every segment regardless of prior failure', () => {
      const ctx = makeContext({ killProcess: () => false })
      const lines = texts('kill 1 ; run a', ctx)
      expect(lines.some((l) => l.includes('No such process'))).toBe(true)
      expect(lines.some((l) => l.includes('Started process'))).toBe(true)
    })

    it('&& short-circuits after a failure and keeps skipping through a chain', () => {
      const spawnProcess = vi.fn((name: string) => makeProcess({ name }))
      const ctx = makeContext({ killProcess: () => false, spawnProcess })
      executeCommand('kill 1 && run a && run b', ctx)
      expect(spawnProcess).not.toHaveBeenCalled()
    })

    it('&& runs the next segment when the previous one succeeded', () => {
      const fsMkdir = vi.fn(() => ({ ok: true as const }))
      const fsWrite = vi.fn(() => ({ ok: true as const }))
      const ctx = makeContext({ fsMkdir, fsWrite })
      const lines = texts('mkdir /tmp && write /tmp/x.txt hi', ctx)
      expect(fsMkdir).toHaveBeenCalledWith('/tmp')
      expect(fsWrite).toHaveBeenCalledWith('/tmp/x.txt', 'hi')
      expect(lines).toEqual(['Created directory /tmp.', 'Wrote to /tmp/x.txt.'])
    })

    it('| filters the previous stage output through grep', () => {
      const ctx = makeContext({
        fsList: () => ({
          ok: true,
          entries: [
            { name: 'boot.log', type: 'file' },
            { name: 'notes.txt', type: 'file' },
          ],
        }),
      })
      expect(texts('ls | grep .log', ctx)).toEqual(['boot.log'])
    })

    it('a pipe stage other than grep errors out', () => {
      const ctx = makeContext()
      expect(executeCommand('ps | sort', ctx)[0]).toMatchObject({ isError: true })
    })

    it('bare grep with no pipe reports there is nothing to search', () => {
      expect(executeCommand('grep foo', makeContext())[0]).toMatchObject({ isError: true })
    })
  })

  describe('stress (roadmap-v3.md §1.3)', () => {
    it('spawns the default count with no argument', () => {
      const spawnStress = vi.fn((n: number) => Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1 })))
      const ctx = makeContext({ spawnStress })
      executeCommand('stress', ctx)
      expect(spawnStress).toHaveBeenCalledWith(6)
    })

    it('spawns the requested count, capped at 20', () => {
      const spawnStress = vi.fn((n: number) => Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1 })))
      const ctx = makeContext({ spawnStress })
      executeCommand('stress 3', ctx)
      expect(spawnStress).toHaveBeenCalledWith(3)
      executeCommand('stress 999', ctx)
      expect(spawnStress).toHaveBeenCalledWith(20)
    })

    it('rejects a non-positive-integer argument', () => {
      expect(executeCommand('stress 0', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('stress -1', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('stress abc', makeContext())[0]).toMatchObject({ isError: true })
    })
  })

  describe('run --threads (roadmap-v4.md §2.1)', () => {
    it('spawns the requested thread count under the given name', () => {
      const spawnThreads = vi.fn((name: string, n: number) =>
        Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1, name: `${name}:t${i + 1}` })),
      )
      const ctx = makeContext({ spawnThreads })
      const lines = texts('run --threads=3 worker', ctx)
      expect(spawnThreads).toHaveBeenCalledWith('worker', 3)
      expect(lines[0]).toContain('Started 3 threads of worker')
    })

    it('falls back to a random name when none is given', () => {
      const spawnThreads = vi.fn((name: string, n: number) =>
        Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1, name: `${name}:t${i + 1}` })),
      )
      executeCommand('run --threads=2', makeContext({ spawnThreads }))
      expect(spawnThreads).toHaveBeenCalledWith(expect.stringMatching(/^proc\d+$/), 2)
    })

    it('does not spawn a normal process as well as the thread group', () => {
      const spawnProcess = vi.fn(() => makeProcess())
      const spawnThreads = vi.fn(() => [makeProcess()])
      executeCommand('run --threads=2 worker', makeContext({ spawnProcess, spawnThreads }))
      expect(spawnProcess).not.toHaveBeenCalled()
    })

    it('rejects a count outside 2-8, or a non-integer', () => {
      expect(executeCommand('run --threads=1 worker', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('run --threads=9 worker', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('run --threads=abc worker', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('run --threads=2.5 worker', makeContext())[0]).toMatchObject({ isError: true })
    })
  })

  describe('free — TLB hit ratio and thrashing (roadmap-v4.md §2.2)', () => {
    it('reports the TLB hit ratio alongside the page-table hit ratio', () => {
      const ctx = makeContext({
        memoryMetrics: () => ({
          pageFaults: 3,
          accesses: 10,
          hitRatio: 0.7,
          externalFragmentation: 0,
          frameCount: 24,
          usedFrames: 5,
          swappedPages: 0,
          tlbHitRatio: 0.4,
          thrashing: false,
        }),
      })
      const lines = texts('free', ctx)
      expect(lines[1]).toContain('TLB hit ratio: 40%')
      expect(lines.some((l) => l.includes('THRASHING'))).toBe(false)
    })

    it('adds a thrashing warning line when the engine reports it', () => {
      const ctx = makeContext({
        memoryMetrics: () => ({
          pageFaults: 18,
          accesses: 20,
          hitRatio: 0.1,
          externalFragmentation: 0,
          frameCount: 24,
          usedFrames: 24,
          swappedPages: 10,
          tlbHitRatio: 0.05,
          thrashing: true,
        }),
      })
      expect(executeCommand('free', ctx).some((l) => l.text.includes('THRASHING'))).toBe(true)
    })
  })

  describe('environment variables (roadmap-v4.md §1.2)', () => {
    it('export sets a variable and echo $VAR substitutes its value', () => {
      const ctx = makeContext()
      executeCommand('export FOO=bar', ctx)
      expect(texts('echo $FOO', ctx)).toEqual(['bar'])
    })

    it('${VAR} braced form also substitutes', () => {
      const ctx = makeContext()
      executeCommand('export FOO=bar', ctx)
      expect(texts('echo ${FOO}', ctx)).toEqual(['bar'])
    })

    it('an unset variable substitutes to an empty string', () => {
      expect(texts('echo $NOPE', makeContext())).toEqual([''])
    })

    it('a literal $ not matching an identifier passes through unchanged', () => {
      expect(texts('echo $ $$ 5$', makeContext())).toEqual(['$ $$ 5$'])
    })

    it('export with no arguments lists every exported variable, sorted', () => {
      const ctx = makeContext()
      executeCommand('export FOO=bar', ctx)
      executeCommand('export BAZ=qux', ctx)
      expect(texts('export', ctx)).toEqual(['BAZ=qux', 'FOO=bar'])
    })

    it('rejects an invalid identifier', () => {
      expect(executeCommand('export 1BAD=x', makeContext())[0]).toMatchObject({ isError: true })
    })

    it('rejects export with no = at all', () => {
      expect(executeCommand('export FOO', makeContext())[0]).toMatchObject({ isError: true })
    })

    it('a value containing a space is not silently truncated at the first word', () => {
      // Found by code review: `export GREETING=hello world` used to set
      // GREETING to just "hello", dropping "world" with no indication.
      const ctx = makeContext()
      executeCommand('export GREETING=hello world', ctx)
      expect(texts('echo $GREETING', ctx)).toEqual(['hello world'])
    })

    it('a later segment on the same chained line sees a variable set earlier on that line, not its stale value', () => {
      const ctx = makeContext()
      expect(texts('export A=1 && echo $A', ctx)).toEqual(['1'])

      executeCommand('export B=old', ctx)
      expect(texts('export B=new && echo $B', ctx)).toEqual(['new'])
    })

    it('substitution reaches into a path argument', () => {
      const fsRead = vi.fn(() => ({ ok: true as const, content: 'hi' }))
      const ctx = makeContext({ fsRead })
      executeCommand('export DIR=/home', ctx)
      executeCommand('cat $DIR/notes.txt', ctx)
      expect(fsRead).toHaveBeenCalledWith('/home/notes.txt')
    })

    it('substitution applies once across a chained line', () => {
      const ctx = makeContext()
      executeCommand('export FOO=bar', ctx)
      expect(texts('echo $FOO ; echo $FOO', ctx)).toEqual(['bar', 'bar'])
    })
  })

  describe('man (roadmap-v4.md §1.4)', () => {
    it('shows a manual entry for a known command', () => {
      const lines = texts('man ls', makeContext())
      expect(lines[0]).toMatch(/^ls -/)
      expect(lines.length).toBeGreaterThanOrEqual(3)
    })

    it('errors for an unknown command', () => {
      expect(executeCommand('man nope', makeContext())[0]).toMatchObject({ isError: true, text: 'No manual entry for nope' })
    })

    it('errors with no argument', () => {
      expect(executeCommand('man', makeContext())[0]).toMatchObject({ isError: true })
    })

    it('has an entry for every command in COMMAND_NAMES', () => {
      for (const name of COMMAND_NAMES) {
        expect(executeCommand(`man ${name}`, makeContext())[0]).not.toMatchObject({ isError: true })
      }
    })

    it('a name colliding with an inherited Object.prototype member errors instead of crashing', () => {
      // Found by code review: MAN_PAGES is a plain object literal, so
      // `MAN_PAGES['constructor']`/`MAN_PAGES['toString']` used to resolve
      // via the prototype chain to a builtin function instead of undefined,
      // skip the "no entry" guard, and throw on the spread below it.
      expect(executeCommand('man constructor', makeContext())[0]).toMatchObject({
        isError: true,
        text: 'No manual entry for constructor',
      })
      expect(executeCommand('man toString', makeContext())[0]).toMatchObject({ isError: true })
      expect(executeCommand('man hasOwnProperty', makeContext())[0]).toMatchObject({ isError: true })
    })
  })

  describe('iostat (roadmap-v4.md §1.1)', () => {
    it('reports the SCAN scheduler status', () => {
      const ctx = makeContext({
        ioMetrics: () => ({
          cylinderCount: 64,
          headPosition: 12,
          pendingCount: 3,
          completedCount: 40,
          avgSeekDistance: 5.5,
          avgWaitTicks: 2.25,
        }),
      })
      const lines = texts('iostat', ctx)
      expect(lines[0]).toBe('Head: cylinder 12/63  Queue depth: 3  Completed: 40')
      expect(lines[1]).toBe('Avg seek distance: 5.5 cylinders  Avg wait: 2.3 ticks')
    })

    it('has a man page', () => {
      const lines = texts('man iostat', makeContext())
      expect(lines[0]).toMatch(/^iostat -/)
    })
  })
})
