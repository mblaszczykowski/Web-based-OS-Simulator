import type { JournalEntry, Process } from '../shared/types'
import { rwxTriplet } from '../filesystem/engine'
import { PIPE_CAPACITY } from '../ipc/pipe'

export interface SchedulerMetricsView {
  completed: number
  avgWaitingTicks: number
  avgTurnaroundTicks: number
  contextSwitches: number
  cpuUtilization: number
}

export interface MemoryMetricsView {
  pageFaults: number
  accesses: number
  hitRatio: number
  externalFragmentation: number
  frameCount: number
  usedFrames: number
  swappedPages: number
  /** TLB hit ratio — roadmap-v4.md §2.2. */
  tlbHitRatio: number
  /** Recent-fault-rate thrashing indicator — roadmap-v4.md §2.2. See MemoryEngine.isThrashing()'s doc for exactly what this measures. */
  thrashing: boolean
}

export interface IoMetricsView {
  cylinderCount: number
  headPosition: number
  pendingCount: number
  completedCount: number
  avgSeekDistance: number
  avgWaitTicks: number
}

/** One open pipe, as the terminal renders it. */
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
  /** Set only by `clear` — a signal for store.ts's runCommand to actually wipe terminalLines, since this module has no access to that state itself. */
  clearScreen?: boolean
}

/**
 * Everything a terminal command needs from the rest of the simulator. The
 * parser below never touches the engines or the Zustand store directly —
 * this is the seam that keeps it independently testable (per plan.md §5,
 * modules only ever talk through a narrow, explicit contract).
 */
export interface CommandContext {
  listProcesses(): Process[]
  spawnProcess(name: string): Process
  /** Immediately spawns `n` CPU-bound processes — roadmap-v3.md §1.3's `stress`. */
  spawnStress(n: number): Process[]
  /** `n` threads of one process, sharing a single address space — roadmap-v4.md §2.1's `run --threads=n`. */
  spawnThreads(name: string, n: number): Process[]
  /** Two processes joined by a real kernel pipe — roadmap-v5.md §1.2's `pipe <writer> <reader>`. */
  spawnPipeline(writerName: string, readerName: string): [Process, Process]
  /** Open pipes and their buffer occupancy — backs `pipe` with no arguments and `lsof`. */
  pipeStatus(): PipeStatusView[]
  killProcess(pid: number): boolean
  /** SIGSTOP / SIGCONT — roadmap-v3.md §2.2. */
  stopProcess(pid: number): boolean
  contProcess(pid: number): boolean
  schedulerMetrics(): SchedulerMetricsView
  memoryMetrics(): MemoryMetricsView
  fsList(
    path: string,
  ): { ok: true; entries: { name: string; type: string; mode?: number; size?: number }[] } | { ok: false; error: string }
  fsRead(path: string): { ok: true; content: string } | { ok: false; error: string }
  fsCreate(path: string): { ok: true } | { ok: false; error: string }
  fsWrite(path: string, text: string): { ok: true } | { ok: false; error: string }
  fsDelete(path: string): { ok: true } | { ok: false; error: string }
  fsMkdir(path: string): { ok: true } | { ok: false; error: string }
  fsMove(src: string, dest: string): { ok: true } | { ok: false; error: string }
  fsCopy(src: string, dest: string): { ok: true } | { ok: false; error: string }
  fsLink(target: string, link: string): { ok: true } | { ok: false; error: string }
  fsChmod(path: string, mode: number): { ok: true } | { ok: false; error: string }
  fsCrash(): void
  fsFsck(): { replayed: JournalEntry[] }
  fsCrashed(): boolean
  fsReset(): void
  /** SCAN disk-head scheduler metrics — roadmap-v4.md §1.1. */
  ioMetrics(): IoMetricsView
  /** Current working directory — roadmap-v3.md §1.1. */
  getCwd(): string
  setCwd(path: string): void
  /** Environment variables — roadmap-v4.md §1.2. A plain key-value store, not a scripting language: see substituteEnvVars(). */
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
  '  rm <file>            delete a file, supports * wildcards',
  '  crash               simulate a power loss mid-write',
  '  fsck                replay the journal and recover the filesystem',
  '  reset-fs             wipe the disk (in memory and the persisted copy)',
  '  iostat               disk I/O scheduler status (SCAN head position, queue, seek/wait)',
  '  pipe <w> <r>          spawn two processes joined by a real kernel pipe',
  '  pipe                  list open pipes and their buffer occupancy',
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

/** All command names — exported so the terminal UI can tab-complete against them. */
export const COMMAND_NAMES = [
  'ps',
  'top',
  'run',
  'stress',
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
  'pipe',
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

/** Short manual pages — roadmap-v4.md §1.4. One entry per COMMAND_NAMES; a static map, no per-command logic. */
const MAN_PAGES: Record<string, string[]> = {
  ps: ['ps - list processes', 'usage: ps', 'Shows every process with its pid, state, and MLFQ queue level.', 'example: ps'],
  top: ['top - live scheduler summary', 'usage: top', 'CPU utilization, process counts by state, average waiting/turnaround, context switches.', 'example: top'],
  run: ['run - spawn a new process, or threads of one', 'usage: run [name] | run --threads=<n> [name]', '--threads spawns n (2-8) threads sharing one address space, each with its own scheduler entry. A random name is used if omitted.', 'example: run --threads=3 compiler'],
  stress: ['stress - spawn many CPU-bound processes at once', 'usage: stress [n]', 'Spawns n (default 6, capped at 20) processes to show MLFQ demotion and Clock evictions under load.', 'example: stress 12'],
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
  ln: ['ln - create a hard link', 'usage: ln <target> <link>', 'The link shares content with target; editing one is visible through the other.', 'example: ln /notes.txt /home/notes-link.txt'],
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
  iostat: ['iostat - disk I/O scheduler status', 'usage: iostat', 'SCAN head position/direction, pending queue depth, average seek distance and wait, requests completed.', 'example: iostat'],
  pipe: [
    'pipe - connect two processes with a real kernel pipe',
    'usage: pipe <writer> <reader> | pipe',
    'Spawns both processes and joins them with a bounded buffer: the writer blocks when it fills, the reader when it empties, and each wakes the other. With no arguments, lists open pipes.',
    "This is NOT the shell's |, which is a filter over one command's rendered output and involves no processes at all.",
    'example: pipe producer consumer',
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
/** Safety valve on an explicit user request — nothing else in the sim ever spawns this many processes at once. */
const MAX_STRESS_COUNT = 20

/** roadmap-v4.md §2.1 — below 2 there's no second thread to share memory with (that's just `run`); above 8 the Gantt chart/ps table stop being legible. */
export const MIN_THREADS = 2
export const MAX_THREADS = 8

export interface RunFlags {
  /** Parsed `--threads=<n>` count, or null if the flag was absent, or if present but invalid (see threadsInvalid). */
  threadCount: number | null
  /** True if a `--threads=` flag was present but failed validation (non-integer, or outside MIN_THREADS..MAX_THREADS). */
  threadsInvalid: boolean
  /** `args` with the `--threads=<n>` token (if any) removed — still needs the caller's own empty-name fallback. */
  nameArgs: string[]
}

/**
 * Shared `run --threads=<n>` flag parsing (roadmap-v4.md §2.1) — used by
 * both this dispatcher and syscallTrace.ts's `run` case, so the two can't
 * silently drift apart on what counts as a valid flag (found by code
 * review: syscallTrace.ts used to re-derive this from scratch and never
 * checked validity at all, so a rejected `run --threads=99 foo` still got a
 * fabricated successful fork()/execve() trace).
 */
export function parseRunFlags(args: string[]): RunFlags {
  const threadsArg = args.find((a) => a.startsWith('--threads='))
  const nameArgs = args.filter((a) => a !== threadsArg)
  if (!threadsArg) return { threadCount: null, threadsInvalid: false, nameArgs }
  const n = Number(threadsArg.slice('--threads='.length))
  const valid = Number.isInteger(n) && n >= MIN_THREADS && n <= MAX_THREADS
  return { threadCount: valid ? n : null, threadsInvalid: !valid, nameArgs }
}

/** Collapses `.`/`..` segments in an already-absolute path. `/a/../b` -> `/b`, `/a/./b` -> `/a/b`. */
function collapseDots(path: string): string {
  const segments: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') segments.pop()
    else segments.push(seg)
  }
  return `/${segments.join('/')}`
}

/**
 * Resolves a possibly-relative command argument against the current working
 * directory (roadmap-v3.md §1.1) — the one path-handling seam every file
 * command routes through. An absolute argument (leading `/`) is used as-is
 * (after collapsing any `.`/`..` in it); a relative one is joined onto
 * `cwd` first. A missing argument resolves to `cwd` itself, which is the
 * correct default for `ls` (list the current directory) — commands that
 * require an argument (cat, write, ...) still guard for it themselves
 * before calling this.
 */
export function resolvePath(cwd: string, pathArg: string | undefined): string {
  if (!pathArg) return cwd
  const base = pathArg.startsWith('/') ? pathArg : cwd === '/' ? `/${pathArg}` : `${cwd}/${pathArg}`
  return collapseDots(base)
}

/**
 * Parses a chmod mode argument. Accepts 1-3 octal digits, matching the
 * familiar Unix `chmod 644` shape — but since this simulator has exactly
 * one user, only the OWNER (leftmost) digit is meaningful; `chmod 644` and
 * `chmod 6` do exactly the same thing here. Returns null for anything that
 * isn't 1-3 digits in 0-7.
 */
function parseMode(input: string | undefined): number | null {
  if (!input || !/^[0-7]{1,3}$/.test(input)) return null
  return Number(input[0])
}

/**
 * The STATE column in `ps`. WAITING alone stopped being enough once a
 * process could be waiting for genuinely different things (roadmap-v5.md
 * §1.1/§1.2) — "waiting on the disk head" and "waiting for a pipe reader"
 * behave nothing alike, and which one it is now determines whether the
 * process is even reachable by anything the user can do.
 */
function formatState(p: Process): string {
  if (p.state !== 'WAITING' || p.blockedOn === null) return p.state
  const label = { device: 'disk', pipe: 'pipe', 'io-burst': 'io' }[p.blockedOn]
  return `WAITING(${label})`
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** One `ls -l` row. Directories don't carry a real Inode (only files do), so they're shown as always-traversable `drwx` — this simulator never restricts directory access, only file content (roadmap-v3.md §2.3). */
function formatLongEntry(entry: { name: string; type: string; mode?: number; size?: number }): string {
  const isDir = entry.type === 'dir'
  const kind = isDir ? 'd' : '-'
  const rwx = rwxTriplet(isDir ? 0b111 : entry.mode ?? 0)
  const size = String(entry.size ?? 0).padStart(6)
  return `${kind}${rwx}  ${size}  ${isDir ? `${entry.name}/` : entry.name}`
}

/** Splits on whitespace but keeps the tail (e.g. `write`'s text) as one chunk. */
function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean)
}

const VAR_REF = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g

/**
 * Substitutes `$VAR`/`${VAR}` with an exported value, or an empty string if
 * unset — roadmap-v4.md §1.2. Applied per `;`/`&&`-segment, right before
 * that segment runs (see runCommandLine) — NOT once upfront over the whole
 * raw line — so `export X=1 && echo $X` sees the value `export` just set,
 * the same left-to-right ordering a real shell gives you (found by code
 * review: substituting everything upfront meant a later segment always saw
 * whatever VAR held *before* the line started, even one set earlier in the
 * very same line). This is deliberately the ceiling of "variables": no
 * quoting exists in this shell (see splitSequence's comment) and none is
 * added here, so a literal `$` that doesn't match an identifier just
 * passes through unchanged, and there's no way to prevent substitution
 * inside a value that happens to contain one.
 *
 * Takes `getEnv` directly rather than a full `CommandContext` — the only
 * thing this needs from it — rather than threading a whole `CommandContext`
 * through for one lookup.
 */
function substituteEnvVars(input: string, getEnv: (name: string) => string | undefined): string {
  return input.replace(VAR_REF, (_match, braced: string | undefined, bare: string | undefined) => {
    const name = braced ?? bare ?? ''
    return getEnv(name) ?? ''
  })
}

/**
 * Translates a simple `*`-only glob into an anchored RegExp. `?` is not a
 * supported wildcard here — it must be escaped to a literal along with the
 * other regex metacharacters, not left to compile as "the preceding
 * character is optional" (found by code review: `rm log?*.txt` was
 * matching `log*.txt` too, silently deleting files with no `?` in their
 * name at all).
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** Splits a possibly-wildcarded path into its containing directory and the final glob segment. */
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

/**
 * The original single-command dispatcher — every case here is one atomic
 * command, no `;`/`&&`/`|`. `piped` mirrors a real shell's tty-vs-pipe
 * output detection for `ls`: one name per line when something downstream
 * (like `grep`) needs to match line-by-line, the compact space-joined
 * column otherwise.
 */
function runSingle(cmd: string, args: string[], ctx: CommandContext, piped = false): CommandOutputLine[] {
  switch (cmd) {
    case 'help':
      return out(...HELP_TEXT)

    case 'ps': {
      const header = 'PID   STATE           QUEUE  CMD'
      const rows = ctx.listProcesses().map((p) =>
        [
          String(p.pid).padEnd(6),
          formatState(p).padEnd(16),
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
        `CPU: ${pct(m.cpuUtilization)}  Procs: ${procs.length} (${running} running, ${ready} ready, ${waiting.length} waiting)`,
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
        `External fragmentation (contiguous arena): ${pct(m.externalFragmentation)}`,
      ]
      if (m.thrashing) lines.push('⚠ THRASHING — recent fault rate is high enough that paging is crowding out real work.')
      return out(...lines)
    }

    case 'cd': {
      const target = args[0] ? resolvePath(ctx.getCwd(), args[0]) : '/'
      // list() only ever succeeds for a path that resolves to an existing
      // directory (root always does) — reusing it here avoids a second,
      // parallel "does this directory exist" check living in the fs engine.
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
        const names = entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name))
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
        const matches = listResult.entries.filter((e) => e.type === 'file' && re.test(e.name))
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
      // Existence is checked via the parent directory listing, not
      // fsRead(path).ok — fsRead now enforces the read permission bit
      // (roadmap-v3.md §2.3), and a write-only existing file (real `touch`
      // needs no read access, just to bump mtime) must still no-op here
      // rather than being mistaken for "missing" and hitting fsCreate's
      // "already exists" error instead.
      const siblings = ctx.fsList(parentDir(path))
      const alreadyExists = siblings.ok && siblings.entries.some((e) => e.name === baseName(path) && e.type === 'file')
      if (alreadyExists) return out(`Touched ${path}.`) // already exists — real touch just bumps mtime, so this is a no-op
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
      if (args.length < 2) return err('ln: usage: ln <target> <link>')
      const cwd = ctx.getCwd()
      const [target, link] = args
      const targetPath = resolvePath(cwd, target)
      const linkPath = resolvePath(cwd, link)
      const result = ctx.fsLink(targetPath, linkPath)
      return result.ok ? out(`${linkPath} => ${targetPath} (hard link).`) : err(result.error)
    }

    case 'grep':
      // Only meaningful as a pipe target (see applyFilter below) — bare
      // `grep` has no stdin to read in this simulator (no long-running
      // processes to actually pipe from).
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
      // The wiped disk only has root — leaving cwd pointing at whatever
      // directory it was in before would break every subsequent
      // cwd-relative command until the user manually `cd /` (found by
      // code review).
      ctx.setCwd('/')
      return out('[RESET] disk wiped — a fresh, empty filesystem is now mounted.')
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
      // No quoting support in this shell (roadmap-v4.md §1.2's stated scope) —
      // a bare space in the value has nowhere else to go, so the remaining
      // whitespace-separated args are rejoined into the value instead of
      // being silently dropped (found by code review: `export G=hello world`
      // used to set G to just "hello" with no indication "world" went missing).
      const value = [args[0]!.slice(eq + 1), ...args.slice(1)].join(' ')
      if (!/^[A-Za-z_]\w*$/.test(key)) return err(`export: not a valid identifier: ${key}`)
      ctx.setEnv(key, value)
      return []
    }

    case 'echo':
      return out(args.join(' '))

    case 'man': {
      if (!args[0]) return err('man: usage: man <command>')
      // Object.hasOwn guards against a name that shadows an inherited
      // Object.prototype member (e.g. `man constructor`) resolving truthy
      // via the prototype chain instead of hitting the "no entry" error
      // below (found by code review).
      const page = Object.hasOwn(MAN_PAGES, args[0]) ? MAN_PAGES[args[0]] : undefined
      if (!page) return err(`No manual entry for ${args[0]}`)
      return out(...page)
    }

    case 'clear':
      // The marker is picked up by store.ts's runCommand, which is the only
      // place that actually holds terminalLines — this dispatcher has no
      // state to clear itself (found by code review: a store-level fast
      // path used to guess at this by string-matching the raw line against
      // 'clear' BEFORE running it through the real substitution/segment
      // pipeline, so a line like `export X=clear && $X` never matched and
      // silently never cleared the screen).
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

/**
 * Applies a pipe stage to the previous stage's output lines — roadmap-v3.md
 * §1.2. `grep <pattern>` is the only supported filter (a plain substring
 * match, not a real regex engine); this is intentionally not a general
 * "pipe stdin into any command" mechanism — none of the other commands
 * here read stdin, so piping into them wouldn't mean anything.
 */
function applyFilter(stageText: string, input: CommandOutputLine[]): CommandOutputLine[] {
  const [cmd, ...args] = tokenize(stageText)
  if (cmd === 'grep') {
    const pattern = args.join(' ')
    if (!pattern) return err('grep: usage: <cmd> | grep <pattern>')
    return input.filter((line) => line.text.includes(pattern))
  }
  return err(`${cmd}: not supported as a pipe filter (only 'grep' is)`)
}

/** One `|`-connected pipeline (a single command counts as a pipeline of length 1). */
function splitPipeline(text: string): string[] {
  return text.split('|').map((s) => s.trim()).filter(Boolean)
}

type Connector = '&&' | ';'

/**
 * Splits raw input on `;` and `&&` into an ordered list of pipeline
 * segments, each tagged with the connector that led into it (`null` for
 * the first). Deliberately naive — no quoting support, so a `;`/`&&`/`|`
 * that's meant to be literal text (e.g. inside `write`'s content) will be
 * misparsed as a separator. Real shells solve this with quotes; adding
 * that here would mean a real tokenizer, out of scope per roadmap-v3.md §4
 * ("prawdziwy język skryptowy powłoki").
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

/** One atomic command actually executed (a pipeline stage or a bare command), for syscall tracing. */
export interface RanCommand {
  text: string
  ok: boolean
  /** cwd in effect when this stage ran — resolving its own trace path needs the cwd *at that point*, which can change mid-line (`cd x && cat y`). */
  cwd: string
}

export interface CommandLineResult {
  lines: CommandOutputLine[]
  ran: RanCommand[]
}

function runPipeline(text: string, ctx: CommandContext, ran: RanCommand[]): CommandOutputLine[] {
  const stages = splitPipeline(text)
  if (stages.length === 0) return []

  const firstCwd = ctx.getCwd()
  let lines = runStage(stages[0]!, ctx, stages.length > 1)
  ran.push({ text: stages[0]!, ok: lines.every((l) => !l.isError), cwd: firstCwd })

  for (let i = 1; i < stages.length; i++) {
    const cwd = ctx.getCwd()
    lines = applyFilter(stages[i]!, lines)
    ran.push({ text: stages[i]!, ok: lines.every((l) => !l.isError), cwd })
  }
  return lines
}

/**
 * Top-level entry point: parses `;`/`&&`/`|` (roadmap-v3.md §1.2) and runs
 * every resulting stage against `ctx`, in order. `&&` short-circuits (skips
 * the next segment, without running it) if the previous one produced any
 * error line; `;` always runs regardless. Returns both the combined output
 * (for the terminal) and the list of atomic commands that actually ran
 * (for the syscall trace window, one entry per real command — not per
 * `;`/`&&`-joined line).
 */
export function runCommandLine(input: string, ctx: CommandContext): CommandLineResult {
  const segments = splitSequence(input)
  const lines: CommandOutputLine[] = []
  const ran: RanCommand[] = []
  let lastFailed = false

  for (const segment of segments) {
    if (segment.connector === '&&' && lastFailed) continue
    const resolvedText = substituteEnvVars(segment.text, ctx.getEnv)
    const segmentLines = runPipeline(resolvedText, ctx, ran)
    lines.push(...segmentLines)
    lastFailed = segmentLines.some((l) => l.isError)
  }

  return { lines, ran }
}

/** Convenience wrapper over runCommandLine() for callers that only need the rendered output (e.g. tests). */
export function executeCommand(input: string, ctx: CommandContext): CommandOutputLine[] {
  return runCommandLine(input, ctx).lines
}
