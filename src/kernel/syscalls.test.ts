import { describe, expect, it, vi } from 'vitest'
import { executeCommand, type CommandContext } from '../terminal/commands'
import { makeProcess } from '../scheduler/testHelpers'
import { FdTable } from './fdTable'
import { traceSyscalls } from './syscalls'

// roadmap-v5.md §2.1. The point of these is not that the lines look
// plausible — the old static map managed that — but that each one is
// produced by a real crossing of CommandContext and carries the real
// arguments and the real return value. So every test here drives a real
// command through the wrapped context, rather than calling the tracer
// directly.

function makeContext(overrides: Partial<CommandContext> = {}): CommandContext {
  let cwd = '/'
  const env: Record<string, string> = {}
  return {
    listProcesses: () => [],
    spawnProcess: (name) => makeProcess({ pid: 7, name }),
    spawnStress: (n) => Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1 })),
    spawnThreads: (name, n) => Array.from({ length: n }, (_, i) => makeProcess({ pid: i + 1, name: `${name}:t${i + 1}` })),
    spawnPipeline: (w, r) => [makeProcess({ pid: 7, name: w }), makeProcess({ pid: 8, name: r })],
    forkProcess: (pid) => makeProcess({ pid: pid + 10 }),
    killProcess: () => true,
    stopProcess: () => true,
    contProcess: () => true,
    schedulerMetrics: () => ({ completed: 0, avgWaitingTicks: 0, avgTurnaroundTicks: 0, contextSwitches: 0, cpuUtilization: 0, coreCount: 1, migrations: 0, loadPerCore: [0] }),
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
      cowFaults: 0,
      sharedFrames: 0,
    }),
    fsList: () => ({ ok: true, entries: [] }),
    fsRead: () => ({ ok: true, content: '' }),
    fsCreate: () => ({ ok: true }),
    fsWrite: () => ({ ok: true }),
    fsDelete: () => ({ ok: true }),
    fsMkdir: () => ({ ok: true }),
    fsMove: () => ({ ok: true }),
    fsCopy: () => ({ ok: true }),
    fsLink: () => ({ ok: true }),
    fsSymlink: () => ({ ok: true }),
    fsChmod: () => ({ ok: true }),
    fsCrash: () => {},
    fsFsck: () => ({ replayed: [] }),
    fsCrashed: () => false,
    fsReset: () => {},
    ioMetrics: () => ({ cylinderCount: 64, headPosition: 0, pendingCount: 0, completedCount: 0, avgSeekDistance: 0, avgWaitTicks: 0 }),
    fsUsage: () => ({ totalBlocks: 64, usedBlocks: 0, freeBlocks: 64, blockSizeBytes: 64, bitmap: Array(64).fill(false) }),
    getCwd: () => cwd,
    setCwd: (path) => {
      cwd = path
    },
    getEnv: (name) => env[name],
    setEnv: (name, value) => {
      env[name] = value
    },
    listEnv: () => env,
    pipeStatus: () => [],
    openFiles: () => [],
    syncStatus: () => ({ capacity: 6, occupancy: 0, mutexLocked: false, producedTotal: 0, consumedTotal: 0, corruptionEvents: 0, unsafe: false }),
    syncSetUnsafe: () => {},
    networkPing: () => {},
    networkCurl: () => {},
    ...overrides,
  }
}

/** Runs `input` through a traced context and returns the syscall lines it produced. */
function trace(input: string, overrides: Partial<CommandContext> = {}, fdTable = new FdTable()): string[] {
  const tracer = traceSyscalls(makeContext(overrides), fdTable)
  executeCommand(input, tracer.ctx)
  return tracer.drain()
}

describe('syscall trace — a log of the real boundary, not a description beside it', () => {
  it('reports the byte count a read actually returned, not a placeholder', () => {
    const lines = trace('cat /notes.txt', { fsRead: () => ({ ok: true, content: 'hello world' }) })
    expect(lines).toEqual([
      'open("/notes.txt", O_RDONLY) = 3',
      'read(3, buf, 4096) = 11', // the real length of "hello world"
      'close(3) = 0',
    ])
  })

  it('reports the byte count a write actually passed', () => {
    const lines = trace('write /notes.txt hello there')
    expect(lines).toContain('write(3, buf, 11) = 11') // "hello there"
  })

  it('distinguishes the real errno instead of a bare -1', () => {
    expect(trace('cat /secret', { fsRead: () => ({ ok: false, error: 'cat: /secret: Permission denied' }) })).toEqual([
      'open("/secret", O_RDONLY) = -1 EACCES',
    ])
    expect(trace('cat /gone', { fsRead: () => ({ ok: false, error: 'cat: /gone: No such file or directory' }) })).toEqual([
      'open("/gone", O_RDONLY) = -1 ENOENT',
    ])
  })

  it('reports the pid that was really created, not a placeholder', () => {
    const lines = trace('run compiler', { spawnProcess: (name) => makeProcess({ pid: 42, name }) })
    expect(lines[0]).toBe('fork() = 42')
    expect(lines[1]).toContain('execve("/bin/compiler"')
  })

  it('reports fork() = -1 ESRCH when the fork was actually refused', () => {
    expect(trace('fork 9', { forkProcess: () => undefined })).toEqual(['fork() = -1 ESRCH'])
  })

  it('emits nothing for a command rejected before it ever reached the kernel', () => {
    // The old map keyed off the command name, so it happily printed a
    // kill() line for a `kill` that never called anything.
    const killProcess = vi.fn(() => true)
    expect(trace('kill', { killProcess })).toEqual([])
    expect(trace('fork abc', {})).toEqual([])
    expect(trace('nonsense-command', {})).toEqual([])
    expect(killProcess).not.toHaveBeenCalled()
  })

  it('reports a failed signal as ESRCH, matching what the call returned', () => {
    expect(trace('kill 9', { killProcess: () => false })).toEqual(['kill(9, SIGKILL) = -1 ESRCH'])
    expect(trace('kill -STOP 9', { stopProcess: () => true })).toEqual(['kill(9, SIGSTOP) = 0'])
    expect(trace('kill -CONT 9', { contProcess: () => true })).toEqual(['kill(9, SIGCONT) = 0'])
  })

  it('reports the real number of directory entries', () => {
    const lines = trace('ls /', {
      fsList: () => ({ ok: true, entries: [{ name: 'a', type: 'file' }, { name: 'b', type: 'dir' }] }),
    })
    expect(lines).toContain('getdents64(3, ...) = 2')
  })

  it('reuses fd 3 across commands, because the descriptor is really released', () => {
    const fdTable = new FdTable()
    expect(trace('cat /a', {}, fdTable)[0]).toBe('open("/a", O_RDONLY) = 3')
    expect(trace('cat /b', {}, fdTable)[0]).toBe('open("/b", O_RDONLY) = 3')
    expect(fdTable.all()).toEqual([]) // and nothing is leaked between commands
  })

  it('traces every stage of a chained line, in the order they really ran', () => {
    const lines = trace('mkdir /tmp && write /tmp/x.txt hi')
    expect(lines).toEqual([
      'mkdir("/tmp", 0755) = 0',
      'open("/tmp/x.txt", O_CREAT|O_WRONLY|O_APPEND, 0644) = 3',
      'write(3, buf, 2) = 2',
      'close(3) = 0',
    ])
  })

  it('stops tracing at a && that short-circuited — nothing after it ran', () => {
    const lines = trace('mkdir /tmp && write /tmp/x.txt hi', { fsMkdir: () => ({ ok: false, error: 'mkdir: /tmp: File exists' }) })
    expect(lines).toEqual(['mkdir("/tmp", 0755) = -1 EEXIST'])
  })

  it('reports how many journal entries fsck actually replayed', () => {
    const lines = trace('fsck', {
      fsFsck: () => ({ replayed: [{ id: 1, op: 'write', path: '/a', status: 'pending', tick: 1 }] }),
    })
    expect(lines[0]).toContain('1 journal entr')
  })

  it('records chdir only when the directory really changed', () => {
    expect(trace('cd /home')).toEqual(['openat(AT_FDCWD, "/home", O_DIRECTORY) = 3', 'getdents64(3, ...) = 0', 'close(3) = 0', 'chdir("/home") = 0'])
    // A `cd` into a directory that doesn't exist never reaches setCwd.
    expect(trace('cd /nope', { fsList: () => ({ ok: false, error: 'no' }) })).toEqual([
      'openat(AT_FDCWD, "/nope", O_DIRECTORY) = -1 ENOENT',
    ])
  })

  it('does not record path resolution or variable lookups as syscalls', () => {
    // getCwd/getEnv are shell-local state, not kernel state — recording
    // them would bury every real line under one getcwd() per argument.
    expect(trace('pwd')).toEqual([])
    expect(trace('export HOME=/home/guest')).toEqual([])
    expect(trace('echo $HOME')).toEqual([])
  })

  it('reports the two directions of the race demo as the two different calls they are', () => {
    // Not one call that succeeds one way and fails the other: turning the
    // demo on tears the mutex down, turning it off builds a fresh one.
    expect(trace('race on')).toEqual(['sem_destroy(&mutex) = 0'])
    expect(trace('race off')).toEqual(['sem_init(&mutex, 0, 1) = 0'])
    expect(trace('race sideways')).toEqual([]) // rejected by the parser, never reached the kernel
  })

  it('records the symlink target as written, not as resolved', () => {
    expect(trace('ln -s notes.txt /home/link')).toEqual(['symlink("notes.txt", "/home/link") = 0'])
  })

  it('records one clone() per thread actually created, and none for a rejected flag', () => {
    const lines = trace('run --threads=3 worker')
    expect(lines.filter((l) => l.startsWith('clone('))).toHaveLength(3)
    expect(trace('run --threads=99 worker')).toEqual([])
  })
})
