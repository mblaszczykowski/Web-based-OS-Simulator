import type { JournalEntry, Process } from '../shared/types'
import { rwxTriplet } from '../filesystem/engine'
import { PIPE_CAPACITY } from '../ipc/pipe'

export interface SchedulerMetricsView {
  completed: number
  avgWaitingTicks: number
  avgTurnaroundTicks: number
  contextSwitches: number
  cpuUtilization: number
  coreCount: number
  migrations: number
  loadPerCore: number[]
}

export interface MemoryMetricsView {
  pageFaults: number
  accesses: number
  hitRatio: number
  externalFragmentation: number
  frameCount: number
  usedFrames: number
  swappedPages: number
  tlbHitRatio: number
  thrashing: boolean
  cowFaults: number
  sharedFrames: number
}

export interface IoMetricsView {
  cylinderCount: number
  headPosition: number
  pendingCount: number
  completedCount: number
  avgSeekDistance: number
  avgWaitTicks: number
}

export interface OpenFileView {
  pid: number
  processName: string
  fd: number
  kind: string
  target: string
}

export interface PipeStatusView {
  id: number
  writerPid: number
  readerPid: number
  occupancy: number
  capacity: number
  writtenTotal: number
  readTotal: number
  writerOpen: boolean
  readerOpen: boolean
}

export interface FsUsageView {
  totalBlocks: number
  usedBlocks: number
  freeBlocks: number
  blockSizeBytes: number
  bitmap: boolean[]
}

export interface SyncStatusView {
  capacity: number
  occupancy: number
  mutexLocked: boolean
  producedTotal: number
  consumedTotal: number
  corruptionEvents: number
  unsafe: boolean
}

export interface CommandOutputLine {
  text: string
  isError?: boolean
  clearScreen?: boolean
}

/**
 * Everything a command needs from the rest of the simulator. The parser
 * never touches an engine or the store directly, which is what keeps it
 * independently testable — and what makes this the system-call boundary
 * the syscall trace wraps.
 */
export interface CommandContext {
  listProcesses(): Process[]
  spawnProcess(name: string): Process
  spawnStress(n: number): Process[]
  spawnThreads(name: string, n: number): Process[]
  spawnPipeline(writerName: string, readerName: string): [Process, Process]
  forkProcess(pid: number): Process | undefined
  pipeStatus(): PipeStatusView[]
  openFiles(): OpenFileView[]
  killProcess(pid: number): boolean
  stopProcess(pid: number): boolean
  contProcess(pid: number): boolean
  schedulerMetrics(): SchedulerMetricsView
  memoryMetrics(): MemoryMetricsView
  fsList(
    path: string,
  ):
    | { ok: true; entries: { name: string; type: string; mode?: number; size?: number; target?: string }[] }
    | { ok: false; error: string }
  fsRead(path: string): { ok: true; content: string } | { ok: false; error: string }
  fsCreate(path: string): { ok: true } | { ok: false; error: string }
  fsWrite(path: string, text: string): { ok: true } | { ok: false; error: string }
  fsDelete(path: string): { ok: true } | { ok: false; error: string }
  fsMkdir(path: string): { ok: true } | { ok: false; error: string }
  fsMove(src: string, dest: string): { ok: true } | { ok: false; error: string }
  fsCopy(src: string, dest: string): { ok: true } | { ok: false; error: string }
  fsLink(target: string, link: string): { ok: true } | { ok: false; error: string }
  fsSymlink(target: string, link: string): { ok: true } | { ok: false; error: string }
  fsChmod(path: string, mode: number): { ok: true } | { ok: false; error: string }
  fsCrash(): void
  fsFsck(): { replayed: JournalEntry[] }
  fsCrashed(): boolean
  fsReset(): void
  ioMetrics(): IoMetricsView
  fsUsage(): FsUsageView
  getCwd(): string
  setCwd(path: string): void
  getEnv(name: string): string | undefined
  setEnv(name: string, value: string): void
  listEnv(): Record<string, string>
  syncStatus(): SyncStatusView
  syncSetUnsafe(unsafe: boolean): void
  networkPing(host: string): void
  networkCurl(host: string): void
}

const HELP_TEXT = [
  'Available commands:',
  '  ps                 list processes',
  '  top                live scheduler summary',
  '  run <name>          spawn a new process',
  '  run --threads=<n> <name>  spawn n (2-8) threads of one process, sharing one address space',
  '  stress [n]           spawn n (default 6) CPU-bound processes at once',
  '  fork <pid>            duplicate a process, sharing its memory copy-on-write',
  '  kill <pid>          terminate a process',
  '  kill -STOP <pid>      pause a process (SIGSTOP) without terminating it',
  '  kill -CONT <pid>      resume a stopped process (SIGCONT)',
  '  free                memory usage summary',
  '  cd [dir]             change working directory (no arg -> /)',
  '  pwd                  print working directory',
  '  ls [-l] [path]        list a directory (default: cwd), supports * wildcards',
  '                        -l shows permissions (rwx) and size',
  '  chmod <mode> <file>   set permissions (1-3 octal digits, e.g. 644 or 6)',
  '  cat <file>           print a file',
  '  write <file> <text>  append text to a file (creates it if missing)',
  '  touch <file>          create an empty file (no-op if it already exists)',
  '  mkdir <dir>           create a directory',
  '  mv <src> <dest>       move/rename a file',
  '  cp <src> <dest>       copy a file',
  '  ln <target> <link>    create a hard link (shares content with target)',
  '  ln -s <target> <link>  create a symbolic link (a name pointing at a path)',
  '  rm <file>            delete a file, supports * wildcards',
  '  crash               simulate a power loss mid-write',
  '  fsck                replay the journal and recover the filesystem',
  '  reset-fs             wipe the disk (in memory and the persisted copy)',
  '  iostat               disk I/O scheduler status (SCAN head position, queue, seek/wait)',
  '  df [-m]               disk block usage; -m also prints the free-space bitmap',
  '  pipe <w> <r>          spawn two processes joined by a real kernel pipe',
  '  pipe                  list open pipes and their buffer occupancy',
  '  lsof                  list open file descriptors, per process',
  '  sync                bounded-buffer producer/consumer status',
  '  race on|off          toggle the unsynchronized (racy) demo mode',
  '  ping [host]           send simulated ICMP echo packets to a host',
  '  curl [host]           simulate one HTTP request/response round trip',
  '  export [KEY=VALUE]   set an environment variable, or list all if no argument',
  '  echo [args...]        print arguments, after $VAR substitution',
  '  man <command>         show a short manual page for a command',
  '  clear                clear the screen',
  '  help                 show this message',
  '',
  'Paths are relative to the current directory unless they start with /.',
  'Chain commands with ; (always run next), && (run next only on success),',
  'or filter output with | (a shell-level filter; only `grep <pattern>` is supported), e.g.:',
  '  ls | grep .log',
  '  mkdir /tmp && write /tmp/x.txt hi',
  '$VAR and ${VAR} are substituted with an exported value (empty if unset) before a line runs.',
  'Note | is a shell filter over rendered output, not a kernel pipe — see `man pipe`.',
]

export const COMMAND_NAMES = [
  'ps',
  'top',
  'run',
  'stress',
  'fork',
  'kill',
  'free',
  'cd',
  'pwd',
  'ls',
  'cat',
  'write',
  'touch',
  'mkdir',
  'mv',
  'cp',
  'ln',
  'chmod',
  'rm',
  'grep',
  'crash',
  'fsck',
  'reset-fs',
  'iostat',
  'df',
  'pipe',
  'lsof',
  'sync',
  'race',
  'ping',
  'curl',
  'export',
  'echo',
  'man',
  'clear',
  'help',
]

const MAN_PAGES: Record<string, string[]> = {
  ps: [
    'ps - list processes',
    'usage: ps',
    'Shows every process with its pid, state (including what a blocked one is waiting for), the CPU it is bound to, and its MLFQ queue level.',
    'example: ps',
  ],
  top: [
    'top - live scheduler summary',
    'usage: top',
    'CPU utilization across every core, process counts by state, runnable processes per CPU and the migration count, average waiting/turnaround, context switches.',
    'example: top',
  ],
  run: ['run - spawn a new process, or threads of one', 'usage: run [name] | run --threads=<n> [name]', '--threads spawns n (2-8) threads sharing one address space, each with its own scheduler entry. A random name is used if omitted.', 'example: run --threads=3 compiler'],
  stress: ['stress - spawn many CPU-bound processes at once', 'usage: stress [n]', 'Spawns n (default 6, capped at 20) processes to show MLFQ demotion and Clock evictions under load.', 'example: stress 12'],
  fork: [
    'fork - duplicate a process with a copy-on-write address space',
    'usage: fork <pid>',
    'The child shares every resident page of the parent read-only; the first write by either side copies that frame. `free` shows unchanged usage right after the fork and only climbs once they diverge.',
    'example: fork 3',
  ],
  kill: ['kill - terminate or pause/resume a process', 'usage: kill <pid> | kill -STOP <pid> | kill -CONT <pid>', '-STOP/-CONT send SIGSTOP/SIGCONT (pause/resume) instead of terminating.', 'example: kill -STOP 3'],
  free: ['free - memory usage summary', 'usage: free', 'Frames used, page faults, hit ratio, TLB hit ratio, external fragmentation, and a thrashing warning when the recent fault rate is high.', 'example: free'],
  cd: ['cd - change the working directory', 'usage: cd [dir]', 'No argument returns to /. Relative paths resolve against the current directory.', 'example: cd /home'],
  pwd: ['pwd - print the working directory', 'usage: pwd', 'example: pwd'],
  ls: ['ls - list a directory', 'usage: ls [-l] [path]', 'Defaults to the current directory; supports * wildcards. -l shows permissions and size.', 'example: ls -l /home'],
  cat: ['cat - print a file', 'usage: cat <file>', 'example: cat /notes.txt'],
  write: ['write - append text to a file', 'usage: write <file> <text>', 'Creates the file first if it does not exist.', 'example: write /notes.txt hello world'],
  touch: ['touch - create an empty file', 'usage: touch <file>', 'A no-op if the file already exists.', 'example: touch /todo.txt'],
  mkdir: ['mkdir - create a directory', 'usage: mkdir <dir>', 'example: mkdir /projects'],
  mv: ['mv - move or rename a file', 'usage: mv <src> <dest>', 'example: mv /a.txt /archive/a.txt'],
  cp: ['cp - copy a file', 'usage: cp <src> <dest>', 'example: cp /a.txt /a.bak.txt'],
  ln: [
    'ln - create a hard link, or with -s a symbolic one',
    'usage: ln <target> <link> | ln -s <target> <link>',
    'A hard link is a second name for the same inode: content is shared, and the file survives until every name is removed. A symbolic link stores the target *path* instead, so it may dangle, and `rm` on it removes the link rather than the target.',
    'example: ln -s /notes.txt /home/notes',
  ],
  chmod: ['chmod - change file permissions', 'usage: chmod <mode> <file>', 'mode is 1-3 octal digits (e.g. 644 or 6); only the owner digit is meaningful here.', 'example: chmod 644 /notes.txt'],
  rm: ['rm - delete a file', 'usage: rm <file>', 'Supports * wildcards.', 'example: rm *.tmp'],
  grep: [
    'grep - filter piped output by substring',
    'usage: <command> | grep <pattern>',
    "Only works as a filter target; a plain substring match, not a regex engine. The shell's | is not a kernel pipe — see `man pipe`.",
    'example: ls | grep .log',
  ],
  crash: ['crash - simulate a power loss mid-write', 'usage: crash', 'Leaves a pending write in the journal; recover with fsck.', 'example: crash'],
  fsck: ['fsck - replay the journal and recover the filesystem', 'usage: fsck', 'example: fsck'],
  'reset-fs': ['reset-fs - wipe the disk', 'usage: reset-fs', 'Clears both the in-memory and persisted filesystem back to a fresh, empty disk.', 'example: reset-fs'],
  df: [
    'df - disk block usage',
    'usage: df [-m]',
    'Blocks used and free, straight from the free-space bit vector the allocator actually consults. -m prints the bitmap itself, one character per block.',
    'example: df -m',
  ],
  iostat: ['iostat - disk I/O scheduler status', 'usage: iostat', 'SCAN head position/direction, pending queue depth, average seek distance and wait, requests completed.', 'example: iostat'],
  pipe: [
    'pipe - connect two processes with a real kernel pipe',
    'usage: pipe <writer> <reader> | pipe',
    'Spawns both processes and joins them with a bounded buffer: the writer blocks when it fills, the reader when it empties, and each wakes the other. With no arguments, lists open pipes.',
    "This is NOT the shell's |, which is a filter over one command's rendered output and involves no processes at all.",
    'example: pipe producer consumer',
  ],
  lsof: [
    'lsof - list open file descriptors',
    'usage: lsof',
    'Every live process holds stdin/stdout/stderr; a pipe endpoint also holds its end of the channel. The shell opens and closes a file within a single command, so ordinary files are not listed between commands — watch the syscall trace for those.',
    'example: lsof',
  ],
  sync: ['sync - bounded-buffer producer/consumer status', 'usage: sync', 'Buffer occupancy, mutex state, and produced/consumed/corruption counters.', 'example: sync'],
  race: ['race - toggle the unsynchronized sync demo', 'usage: race on|off', 'on restarts the producer/consumer demo without its mutex, to show the corruption it normally prevents.', 'example: race on'],
  ping: ['ping - send simulated ICMP echo packets', 'usage: ping [host]', 'Watch the Network window for the replies.', 'example: ping server'],
  curl: ['curl - simulate an HTTP request/response', 'usage: curl [host]', 'One simulated round trip; watch the Network window for the response.', 'example: curl server'],
  export: ['export - set or list environment variables', 'usage: export [KEY=VALUE]', 'No argument lists every currently exported variable.', 'example: export HOME=/home/guest'],
  echo: ['echo - print arguments', 'usage: echo [args...]', '$VAR/${VAR} in the arguments are substituted before echo runs.', 'example: echo $HOME'],
  man: ['man - show a manual page for a command', 'usage: man <command>', 'example: man ls'],
  clear: ['clear - clear the terminal screen', 'usage: clear', 'example: clear'],
  help: ['help - list every available command', 'usage: help', 'example: help'],
}

const DEFAULT_STRESS_COUNT = 6
const MAX_STRESS_COUNT = 20

export const MIN_THREADS = 2
export const MAX_THREADS = 8

export interface RunFlags {
  threadCount: number | null
  threadsInvalid: boolean
  nameArgs: string[]
}

export function parseRunFlags(args: string[]): RunFlags {
  const threadsArg = args.find((a) => a.startsWith('--threads='))
  const nameArgs = args.filter((a) => a !== threadsArg)
  if (!threadsArg) return { threadCount: null, threadsInvalid: false, nameArgs }
  const n = Number(threadsArg.slice('--threads='.length))
  const valid = Number.isInteger(n) && n >= MIN_THREADS && n <= MAX_THREADS
  return { threadCount: valid ? n : null, threadsInvalid: !valid, nameArgs }
}

function collapseDots(path: string): string {
  const segments: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') segments.pop()
    else segments.push(seg)
  }
  return `/${segments.join('/')}`
}

/** The one path-handling seam every file command routes through. */
export function resolvePath(cwd: string, pathArg: string | undefined): string {
  if (!pathArg) return cwd
  const base = pathArg.startsWith('/') ? pathArg : cwd === '/' ? `/${pathArg}` : `${cwd}/${pathArg}`
  return collapseDots(base)
}

function parseMode(input: string | undefined): number | null {
  if (!input || !/^[0-7]{1,3}$/.test(input)) return null
  return Number(input[0])
}

function formatState(p: Process): string {
  if (p.state !== 'WAITING' || p.blockedOn === null) return p.state
  const label = { device: 'disk', pipe: 'pipe', 'io-burst': 'io' }[p.blockedOn]
  return `WAITING(${label})`
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

function formatLongEntry(entry: { name: string; type: string; mode?: number; size?: number; target?: string }): string {
  const isDir = entry.type === 'dir'
  const isLink = entry.type === 'symlink'
  const kind = isDir ? 'd' : isLink ? 'l' : '-'
  const rwx = rwxTriplet(isDir || isLink ? 0b111 : entry.mode ?? 0)
  const size = String(entry.size ?? 0).padStart(6)
  const name = isDir ? `${entry.name}/` : isLink ? `${entry.name} -> ${entry.target ?? '?'}` : entry.name
  return `${kind}${rwx}  ${size}  ${name}`
}

function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean)
}

const VAR_REF = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g

/**
 * Applied per `;`/`&&` segment, right before that segment runs, so
 * `export X=1 && echo $X` sees the value just set. This is the ceiling of
 * "variables" here: there is no quoting, so a literal `$` that doesn't
 * match an identifier simply passes through.
 */
function substituteEnvVars(input: string, getEnv: (name: string) => string | undefined): string {
  return input.replace(VAR_REF, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ''
    return getEnv(name) ?? ''
  })
}

/** `*`-only globs. `?` is escaped to a literal rather than left to mean "optional". */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function splitPattern(cwd: string, pathArg: string): { dir: string; pattern: string } {
  const normalized = resolvePath(cwd, pathArg)
  const idx = normalized.lastIndexOf('/')
  const dir = idx <= 0 ? '/' : normalized.slice(0, idx)
  const pattern = normalized.slice(idx + 1)
  return { dir, pattern }
}

function parentDir(absolutePath: string): string {
  const idx = absolutePath.lastIndexOf('/')
  return idx <= 0 ? '/' : absolutePath.slice(0, idx)
}

function baseName(absolutePath: string): string {
  return absolutePath.slice(absolutePath.lastIndexOf('/') + 1)
}

function out(...lines: string[]): CommandOutputLine[] {
  return lines.map((text) => ({ text }))
}

function err(text: string): CommandOutputLine[] {
  return [{ text, isError: true }]
}

function runSingle(cmd: string, args: string[], ctx: CommandContext, piped = false): CommandOutputLine[] {
  switch (cmd) {
    case 'help':
      return out(...HELP_TEXT)

    case 'ps': {
      const header = 'PID   STATE           CPU  QUEUE  CMD'
      const rows = ctx.listProcesses().map((p) =>
        [
          String(p.pid).padEnd(6),
          formatState(p).padEnd(16),
          (p.core === null ? '-' : String(p.core)).padEnd(5),
          (p.state === 'WAITING' || p.state === 'STOPPED' ? '-' : `Q${p.queueLevel}`).padEnd(7),
          p.name,
        ].join(''),
      )
      return out(header, ...rows)
    }

    case 'top': {
      const m = ctx.schedulerMetrics()
      const procs = ctx.listProcesses()
      const running = procs.filter((p) => p.state === 'RUNNING').length
      const ready = procs.filter((p) => p.state === 'READY').length
      const waiting = procs.filter((p) => p.state === 'WAITING')
      const onDisk = waiting.filter((p) => p.blockedOn === 'device').length
      const onPipe = waiting.filter((p) => p.blockedOn === 'pipe').length
      return out(
        `CPU: ${pct(m.cpuUtilization)} across ${m.coreCount} core(s)  Procs: ${procs.length} (${running} running, ${ready} ready, ${waiting.length} waiting)`,
        `Runnable per CPU: ${m.loadPerCore.map((load, core) => `CPU${core}=${load}`).join('  ')}  Migrations: ${m.migrations}`,
        `Blocked: ${onDisk} on disk, ${onPipe} on a pipe, ${waiting.length - onDisk - onPipe} on a self-timed I/O burst`,
        `Avg waiting: ${m.avgWaitingTicks.toFixed(1)} ticks  Avg turnaround: ${m.avgTurnaroundTicks.toFixed(1)} ticks  Ctx switches: ${m.contextSwitches}`,
      )
    }

    case 'run': {
      const { threadCount, threadsInvalid, nameArgs } = parseRunFlags(args)
      if (threadsInvalid) return err(`run: --threads=<n> must be an integer from ${MIN_THREADS} to ${MAX_THREADS}`)
      const name = nameArgs.join(' ') || `proc${Math.floor(Math.random() * 1000)}`
      if (threadCount !== null) {
        const threads = ctx.spawnThreads(name, threadCount)
        return out(
          `Started ${threads.length} threads of ${name}, sharing one address space: ${threads.map((t) => `P${t.pid}`).join(', ')}.`,
        )
      }
      const process = ctx.spawnProcess(name)
      return out(`Started process ${process.pid} (${process.name}).`)
    }

    case 'stress': {
      const arg = args[0]
      if (arg !== undefined && !/^[1-9][0-9]*$/.test(arg)) {
        return err('stress: usage: stress [n]  (n must be a positive integer, default 6)')
      }
      const requested = arg !== undefined ? Number(arg) : DEFAULT_STRESS_COUNT
      const n = Math.min(MAX_STRESS_COUNT, requested)
      const spawned = ctx.spawnStress(n)
      const lines = [`stress: spawned ${spawned.length} CPU-bound process(es): ${spawned.map((p) => `P${p.pid}`).join(', ')}.`]
      if (requested > MAX_STRESS_COUNT) lines.push(`(capped at ${MAX_STRESS_COUNT})`)
      lines.push('Watch the Scheduler window for MLFQ demotion and the Memory window for Clock evictions.')
      return out(...lines)
    }

    case 'fork': {
      const pid = Number(args[0])
      if (!args[0] || Number.isNaN(pid)) return err('fork: usage: fork <pid>')
      const child = ctx.forkProcess(pid)
      if (!child) return err(`fork: (${pid}) - No such process, or it has no address space of its own to duplicate`)
      return out(
        `Forked P${pid} → P${child.pid} (${child.name}).`,
        'Their pages are shared copy-on-write — run `free` now, then again after they have run for a while.',
      )
    }

    case 'kill': {
      if (args[0] === '-STOP' || args[0] === '-CONT') {
        const signal = args[0]
        const pid = Number(args[1])
        if (!args[1] || Number.isNaN(pid)) return err(`kill: usage: kill ${signal} <pid>`)
        const ok = signal === '-STOP' ? ctx.stopProcess(pid) : ctx.contProcess(pid)
        if (!ok) return err(`kill: (${pid}) - No such process`)
        return out(signal === '-STOP' ? `Process ${pid} stopped (SIGSTOP).` : `Process ${pid} continued (SIGCONT).`)
      }
      const pid = Number(args[0])
      if (!args[0] || Number.isNaN(pid)) return err('kill: usage: kill <pid> | kill -STOP <pid> | kill -CONT <pid>')
      const ok = ctx.killProcess(pid)
      return ok ? out(`Process ${pid} terminated.`) : err(`kill: (${pid}) - No such process`)
    }

    case 'free': {
      const m = ctx.memoryMetrics()
      const lines = [
        `Frames: ${m.usedFrames}/${m.frameCount} used  Swapped: ${m.swappedPages} page(s) (see /swap)`,
        `Page faults: ${m.pageFaults}  Accesses: ${m.accesses}  Hit ratio: ${pct(m.hitRatio)}  TLB hit ratio: ${pct(m.tlbHitRatio)}`,
        `Shared (COW) frames: ${m.sharedFrames}  Copy-on-write faults: ${m.cowFaults}`,
        `External fragmentation (contiguous arena): ${pct(m.externalFragmentation)}`,
      ]
      if (m.thrashing) lines.push('⚠ THRASHING — recent fault rate is high enough that paging is crowding out real work.')
      return out(...lines)
    }

    case 'cd': {
      const target = args[0] ? resolvePath(ctx.getCwd(), args[0]) : '/'
      const result = ctx.fsList(target)
      if (!result.ok) return err(`cd: ${args[0] ?? target}: No such file or directory`)
      ctx.setCwd(target)
      return []
    }

    case 'pwd':
      return out(ctx.getCwd())

    case 'ls': {
      const cwd = ctx.getCwd()
      const longFormat = args.includes('-l')
      const pathArg = args.find((a) => a !== '-l')
      const render = (entries: { name: string; type: string; mode?: number; size?: number }[]): CommandOutputLine[] => {
        if (longFormat) return out(...entries.map((e) => formatLongEntry(e)))
        const names = entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.type === 'symlink' ? `${e.name}@` : e.name))
        return piped ? out(...names) : out(names.join('  '))
      }
      if (pathArg?.includes('*')) {
        const { dir, pattern } = splitPattern(cwd, pathArg)
        const result = ctx.fsList(dir)
        if (!result.ok) return err(result.error)
        const re = globToRegExp(pattern)
        const matched = result.entries.filter((e) => re.test(e.name))
        if (matched.length === 0) return err(`ls: cannot access '${pathArg}': No such file or directory`)
        return render(matched)
      }
      const result = ctx.fsList(resolvePath(cwd, pathArg))
      if (!result.ok) return err(result.error)
      if (result.entries.length === 0) return []
      return render(result.entries)
    }

    case 'cat': {
      if (!args[0]) return err('cat: missing file operand')
      const result = ctx.fsRead(resolvePath(ctx.getCwd(), args[0]))
      if (!result.ok) return err(result.error)
      return result.content.length === 0 ? [] : out(...result.content.split('\n'))
    }

    case 'write': {
      if (args.length < 2) return err('write: usage: write <file> <text>')
      const [pathArg, ...rest] = args
      const path = resolvePath(ctx.getCwd(), pathArg)
      const result = ctx.fsWrite(path, rest.join(' '))
      return result.ok ? out(`Wrote to ${path}.`) : err(result.error)
    }

    case 'rm': {
      if (!args[0]) return err('rm: missing file operand')
      const cwd = ctx.getCwd()
      if (args[0].includes('*')) {
        const { dir, pattern } = splitPattern(cwd, args[0])
        const listResult = ctx.fsList(dir)
        if (!listResult.ok) return err(listResult.error)
        const re = globToRegExp(pattern)
        const matches = listResult.entries.filter((e) => e.type !== 'dir' && re.test(e.name))
        if (matches.length === 0) return err(`rm: no files matched '${args[0]}'`)
        return matches.flatMap((m) => {
          const fullPath = dir === '/' ? `/${m.name}` : `${dir}/${m.name}`
          const result = ctx.fsDelete(fullPath)
          return result.ok ? out(`Removed ${fullPath}.`) : err(result.error)
        })
      }
      const path = resolvePath(cwd, args[0])
      const result = ctx.fsDelete(path)
      return result.ok ? out(`Removed ${path}.`) : err(result.error)
    }

    case 'touch': {
      if (!args[0]) return err('touch: missing file operand')
      const path = resolvePath(ctx.getCwd(), args[0])
      const siblings = ctx.fsList(parentDir(path))
      const alreadyExists = siblings.ok && siblings.entries.some((e) => e.name === baseName(path) && e.type === 'file')
      if (alreadyExists) return out(`Touched ${path}.`)
      const result = ctx.fsCreate(path)
      return result.ok ? out(`Touched ${path}.`) : err(result.error)
    }

    case 'mkdir': {
      if (!args[0]) return err('mkdir: missing operand')
      const path = resolvePath(ctx.getCwd(), args[0])
      const result = ctx.fsMkdir(path)
      return result.ok ? out(`Created directory ${path}.`) : err(result.error)
    }

    case 'chmod': {
      if (args.length < 2) return err('chmod: usage: chmod <mode> <file>  (mode: 1-3 octal digits, e.g. 644 or 6)')
      const mode = parseMode(args[0])
      if (mode === null) return err('chmod: invalid mode — expected 1-3 octal digits (0-7)')
      const path = resolvePath(ctx.getCwd(), args[1])
      const result = ctx.fsChmod(path, mode)
      return result.ok ? out(`Changed mode of ${path} to ${rwxTriplet(mode)} (${mode}).`) : err(result.error)
    }

    case 'mv': {
      if (args.length < 2) return err('mv: usage: mv <src> <dest>')
      const cwd = ctx.getCwd()
      const [src, dest] = args
      const srcPath = resolvePath(cwd, src)
      const destPath = resolvePath(cwd, dest)
      const result = ctx.fsMove(srcPath, destPath)
      return result.ok ? out(`Moved ${srcPath} -> ${destPath}.`) : err(result.error)
    }

    case 'cp': {
      if (args.length < 2) return err('cp: usage: cp <src> <dest>')
      const cwd = ctx.getCwd()
      const [src, dest] = args
      const srcPath = resolvePath(cwd, src)
      const destPath = resolvePath(cwd, dest)
      const result = ctx.fsCopy(srcPath, destPath)
      return result.ok ? out(`Copied ${srcPath} -> ${destPath}.`) : err(result.error)
    }

    case 'ln': {
      const symbolic = args[0] === '-s'
      const operands = symbolic ? args.slice(1) : args
      if (operands.length < 2) return err('ln: usage: ln [-s] <target> <link>')
      const cwd = ctx.getCwd()
      const [target, link] = operands
      const linkPath = resolvePath(cwd, link)
      if (symbolic) {
        const result = ctx.fsSymlink(target!, linkPath)
        return result.ok ? out(`${linkPath} -> ${target} (symbolic link).`) : err(result.error)
      }
      const targetPath = resolvePath(cwd, target)
      const result = ctx.fsLink(targetPath, linkPath)
      return result.ok ? out(`${linkPath} => ${targetPath} (hard link).`) : err(result.error)
    }

    case 'grep':
      return err('grep: no input — use it after a pipe, e.g. `ls | grep foo`')

    case 'crash': {
      ctx.fsCrash()
      return out('[CRASH] power loss — pending write left in the journal. Run `fsck` to recover.')
    }

    case 'fsck': {
      const { replayed } = ctx.fsFsck()
      if (replayed.length === 0) return out('[FSCK] journal clean, nothing to replay.')
      const lines = ['[FSCK] scanning journal…']
      for (const entry of replayed) {
        lines.push(`[REPLAY] ${entry.op} ${entry.path} → committed`)
      }
      lines.push('[OK] filesystem consistent')
      return out(...lines)
    }

    case 'reset-fs': {
      ctx.fsReset()
      ctx.setCwd('/')
      return out('[RESET] disk wiped — a fresh, empty filesystem is now mounted.')
    }

    case 'df': {
      const u = ctx.fsUsage()
      const pctUsed = u.totalBlocks === 0 ? 0 : u.usedBlocks / u.totalBlocks
      const lines = [
        'FILESYSTEM   BLOCKS    USED    FREE  USE%  BLOCK SIZE',
        [
          '/dev/sim0'.padEnd(13),
          String(u.totalBlocks).padEnd(10),
          String(u.usedBlocks).padEnd(8),
          String(u.freeBlocks).padEnd(8),
          pct(pctUsed).padEnd(6),
          `${u.blockSizeBytes} B`,
        ].join(''),
      ]
      if (args.includes('-m')) {
        lines.push('', 'Free-space bitmap (# = allocated, . = free):')
        for (let i = 0; i < u.bitmap.length; i += 16) {
          const row = u.bitmap.slice(i, i + 16).map((used) => (used ? '#' : '.')).join('')
          lines.push(`  ${String(i).padStart(4)}  ${row}`)
        }
      }
      return out(...lines)
    }

    case 'iostat': {
      const m = ctx.ioMetrics()
      const blocked = ctx.listProcesses().filter((p) => p.blockedOn === 'device')
      return out(
        `Head: cylinder ${m.headPosition}/${m.cylinderCount - 1}  Queue depth: ${m.pendingCount}  Completed: ${m.completedCount}`,
        `Avg seek distance: ${m.avgSeekDistance.toFixed(1)} cylinders  Avg wait: ${m.avgWaitTicks.toFixed(1)} ticks`,
        blocked.length === 0
          ? 'Processes blocked on this disk: none'
          : `Processes blocked on this disk: ${blocked.map((p) => `P${p.pid}`).join(', ')}`,
      )
    }

    case 'pipe': {
      if (args.length === 0) {
        const open = ctx.pipeStatus()
        if (open.length === 0) return out('No open pipes. Create one with: pipe <writer> <reader>')
        return out(
          'ID  WRITER  READER  BUFFER  WRITTEN  READ',
          ...open.map((p) =>
            [
              String(p.id).padEnd(4),
              `P${p.writerPid}${p.writerOpen ? '' : ' (closed)'}`.padEnd(8),
              `P${p.readerPid}${p.readerOpen ? '' : ' (closed)'}`.padEnd(8),
              `${p.occupancy}/${p.capacity}`.padEnd(8),
              String(p.writtenTotal).padEnd(9),
              String(p.readTotal),
            ].join(''),
          ),
        )
      }
      if (args.length !== 2) return err('pipe: usage: pipe <writer> <reader>  (or `pipe` alone to list open pipes)')
      const [writerName, readerName] = args as [string, string]
      const [writer, reader] = ctx.spawnPipeline(writerName, readerName)
      return out(
        `Started P${writer.pid} (${writer.name}) → P${reader.pid} (${reader.name}) over a ${PIPE_CAPACITY}-slot pipe.`,
        'Watch the Sync window\'s IPC tab: the writer blocks when the buffer fills, the reader when it empties.',
      )
    }

    case 'lsof': {
      const open = ctx.openFiles()
      if (open.length === 0) return out('No live processes.')
      return out(
        'PID   COMMAND       FD   TYPE        NAME',
        ...open.map((f) =>
          [
            String(f.pid).padEnd(6),
            f.processName.slice(0, 12).padEnd(14),
            String(f.fd).padEnd(5),
            f.kind.padEnd(12),
            f.target,
          ].join(''),
        ),
      )
    }

    case 'sync': {
      const s = ctx.syncStatus()
      return out(
        `Buffer: ${s.occupancy}/${s.capacity} occupied  mutex=${s.mutexLocked ? 'locked' : 'free'}  mode=${s.unsafe ? 'UNSAFE (race demo)' : 'safe'}`,
        `Produced: ${s.producedTotal}  Consumed: ${s.consumedTotal}  Corruption events: ${s.corruptionEvents}`,
      )
    }

    case 'race': {
      const mode = args[0]
      if (mode !== 'on' && mode !== 'off') return err('race: usage: race on|off')
      ctx.syncSetUnsafe(mode === 'on')
      return mode === 'on'
        ? out('⚠ Sync demo restarted WITHOUT the mutex — watch for buffer corruption in the sync window.')
        : out('Sync demo restarted with the mutex back in place.')
    }

    case 'ping': {
      const host = args[0] ?? 'server'
      ctx.networkPing(host)
      return out(`PING ${host}: 4 packets sent — watch the Network window for replies.`)
    }

    case 'curl': {
      const host = args[0] ?? 'server'
      ctx.networkCurl(host)
      return out(`GET / HTTP/1.1 -> ${host} — watch the Network window for the response.`)
    }

    case 'export': {
      if (args.length === 0) {
        const entries = Object.entries(ctx.listEnv()).sort(([a], [b]) => a.localeCompare(b))
        return out(...entries.map(([key, value]) => `${key}=${value}`))
      }
      const eq = args[0]!.indexOf('=')
      if (eq === -1) return err('export: usage: export [KEY=VALUE]')
      const key = args[0]!.slice(0, eq)
      const value = [args[0]!.slice(eq + 1), ...args.slice(1)].join(' ')
      if (!/^[A-Za-z_]\w*$/.test(key)) return err(`export: not a valid identifier: ${key}`)
      ctx.setEnv(key, value)
      return []
    }

    case 'echo':
      return out(args.join(' '))

    case 'man': {
      if (!args[0]) return err('man: usage: man <command>')
      const page = Object.hasOwn(MAN_PAGES, args[0]) ? MAN_PAGES[args[0]] : undefined
      if (!page) return err(`No manual entry for ${args[0]}`)
      return out(...page)
    }

    case 'clear':
      return [{ text: '', clearScreen: true }]

    default:
      return err(`command not found: ${cmd}`)
  }
}

function runStage(stageText: string, ctx: CommandContext, piped: boolean): CommandOutputLine[] {
  const [cmd, ...args] = tokenize(stageText)
  if (!cmd) return []
  return runSingle(cmd, args, ctx, piped)
}

function applyFilter(stageText: string, input: CommandOutputLine[]): CommandOutputLine[] {
  const [cmd, ...args] = tokenize(stageText)
  if (cmd === 'grep') {
    const pattern = args.join(' ')
    if (!pattern) return err('grep: usage: <cmd> | grep <pattern>')
    return input.filter((line) => line.text.includes(pattern))
  }
  return err(`${cmd}: not supported as a pipe filter (only 'grep' is)`)
}

function splitPipeline(text: string): string[] {
  return text.split('|').map((s) => s.trim()).filter(Boolean)
}

type Connector = '&&' | ';'

/**
 * Splits on `;` and `&&`. Deliberately naive: no quoting, so a separator
 * meant as literal text is misparsed. Real quoting needs a real tokenizer,
 * which is a bigger project than this shell wants to be.
 */
function splitSequence(input: string): { text: string; connector: Connector | null }[] {
  const tokens = input.split(/(&&|;)/)
  const segments: { text: string; connector: Connector | null }[] = []
  let pending: Connector | null = null
  for (const raw of tokens) {
    const token = raw.trim()
    if (token === '&&' || token === ';') {
      pending = token
      continue
    }
    if (token.length === 0) continue
    segments.push({ text: token, connector: pending })
    pending = null
  }
  return segments
}

function runPipeline(text: string, ctx: CommandContext): CommandOutputLine[] {
  const stages = splitPipeline(text)
  if (stages.length === 0) return []

  let lines = runStage(stages[0]!, ctx, stages.length > 1)
  for (let i = 1; i < stages.length; i++) {
    lines = applyFilter(stages[i]!, lines)
  }
  return lines
}

export function runCommandLine(input: string, ctx: CommandContext): CommandOutputLine[] {
  const segments = splitSequence(input)
  const lines: CommandOutputLine[] = []
  let lastFailed = false

  for (const segment of segments) {
    if (segment.connector === '&&' && lastFailed) continue
    const resolvedText = substituteEnvVars(segment.text, ctx.getEnv)
    const segmentLines = runPipeline(resolvedText, ctx)
    lines.push(...segmentLines)
    lastFailed = segmentLines.some((l) => l.isError)
  }

  return lines
}

export function executeCommand(input: string, ctx: CommandContext): CommandOutputLine[] {
  return runCommandLine(input, ctx)
}
