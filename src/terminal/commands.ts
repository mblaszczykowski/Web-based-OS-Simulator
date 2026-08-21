import type { JournalEntry, Process } from '../shared/types'

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
  killProcess(pid: number): boolean
  schedulerMetrics(): SchedulerMetricsView
  memoryMetrics(): MemoryMetricsView
  fsList(path: string): { ok: true; entries: { name: string; type: string }[] } | { ok: false; error: string }
  fsRead(path: string): { ok: true; content: string } | { ok: false; error: string }
  fsCreate(path: string): { ok: true } | { ok: false; error: string }
  fsWrite(path: string, text: string): { ok: true } | { ok: false; error: string }
  fsDelete(path: string): { ok: true } | { ok: false; error: string }
  fsMkdir(path: string): { ok: true } | { ok: false; error: string }
  fsMove(src: string, dest: string): { ok: true } | { ok: false; error: string }
  fsCopy(src: string, dest: string): { ok: true } | { ok: false; error: string }
  fsLink(target: string, link: string): { ok: true } | { ok: false; error: string }
  fsCrash(): void
  fsFsck(): { replayed: JournalEntry[] }
  fsCrashed(): boolean
  fsReset(): void
  /** Current working directory — roadmap-v3.md §1.1. */
  getCwd(): string
  setCwd(path: string): void
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
  '  stress [n]           spawn n (default 6) CPU-bound processes at once',
  '  kill <pid>          terminate a process',
  '  free                memory usage summary',
  '  cd [dir]             change working directory (no arg -> /)',
  '  pwd                  print working directory',
  '  ls [path]           list a directory (default: cwd), supports * wildcards',
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
  '  sync                bounded-buffer producer/consumer status',
  '  race on|off          toggle the unsynchronized (racy) demo mode',
  '  ping [host]           send simulated ICMP echo packets to a host',
  '  curl [host]           simulate one HTTP request/response round trip',
  '  clear                clear the screen',
  '  help                 show this message',
  '',
  'Paths are relative to the current directory unless they start with /.',
  'Chain commands with ; (always run next), && (run next only on success),',
  'or pipe output through a filter with | (only `grep <pattern>` is supported), e.g.:',
  '  ls | grep .log',
  '  mkdir /tmp && write /tmp/x.txt hi',
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
  'rm',
  'grep',
  'crash',
  'fsck',
  'reset-fs',
  'sync',
  'race',
  'ping',
  'curl',
  'clear',
  'help',
]

const DEFAULT_STRESS_COUNT = 6
/** Safety valve on an explicit user request — nothing else in the sim ever spawns this many processes at once. */
const MAX_STRESS_COUNT = 20

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

function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

/** Splits on whitespace but keeps the tail (e.g. `write`'s text) as one chunk. */
function tokenize(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean)
}

/** Translates a simple `*`-only glob into an anchored RegExp. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
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
      const header = 'PID   STATE       QUEUE  CMD'
      const rows = ctx.listProcesses().map((p) =>
        [
          String(p.pid).padEnd(6),
          p.state.padEnd(12),
          (p.state === 'WAITING' ? '-' : `Q${p.queueLevel}`).padEnd(7),
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
      const waiting = procs.filter((p) => p.state === 'WAITING').length
      return out(
        `CPU: ${pct(m.cpuUtilization)}  Procs: ${procs.length} (${running} running, ${ready} ready, ${waiting} waiting)`,
        `Avg waiting: ${m.avgWaitingTicks.toFixed(1)} ticks  Avg turnaround: ${m.avgTurnaroundTicks.toFixed(1)} ticks  Ctx switches: ${m.contextSwitches}`,
      )
    }

    case 'run': {
      const name = args.join(' ') || `proc${Math.floor(Math.random() * 1000)}`
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
      const pid = Number(args[0])
      if (!args[0] || Number.isNaN(pid)) return err('kill: usage: kill <pid>')
      const ok = ctx.killProcess(pid)
      return ok ? out(`Process ${pid} terminated.`) : err(`kill: (${pid}) - No such process`)
    }

    case 'free': {
      const m = ctx.memoryMetrics()
      return out(
        `Frames: ${m.usedFrames}/${m.frameCount} used  Swapped: ${m.swappedPages} page(s) (see /swap)`,
        `Page faults: ${m.pageFaults}  Accesses: ${m.accesses}  Hit ratio: ${pct(m.hitRatio)}`,
        `External fragmentation (contiguous arena): ${pct(m.externalFragmentation)}`,
      )
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
      const render = (entries: { name: string; type: string }[]): CommandOutputLine[] => {
        const names = entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name))
        return piped ? out(...names) : out(names.join('  '))
      }
      if (args[0]?.includes('*')) {
        const { dir, pattern } = splitPattern(cwd, args[0])
        const result = ctx.fsList(dir)
        if (!result.ok) return err(result.error)
        const re = globToRegExp(pattern)
        const matched = result.entries.filter((e) => re.test(e.name))
        if (matched.length === 0) return err(`ls: cannot access '${args[0]}': No such file or directory`)
        return render(matched)
      }
      const result = ctx.fsList(resolvePath(cwd, args[0]))
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
      if (ctx.fsRead(path).ok) return out(`Touched ${path}.`) // already exists — real touch just bumps mtime, so this is a no-op
      const result = ctx.fsCreate(path)
      return result.ok ? out(`Touched ${path}.`) : err(result.error)
    }

    case 'mkdir': {
      if (!args[0]) return err('mkdir: missing operand')
      const path = resolvePath(ctx.getCwd(), args[0])
      const result = ctx.fsMkdir(path)
      return result.ok ? out(`Created directory ${path}.`) : err(result.error)
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
      return out('[RESET] disk wiped — a fresh, empty filesystem is now mounted.')
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

    case 'clear':
      return []

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
    const segmentLines = runPipeline(segment.text, ctx, ran)
    lines.push(...segmentLines)
    lastFailed = segmentLines.some((l) => l.isError)
  }

  return { lines, ran }
}

/** Convenience wrapper over runCommandLine() for callers that only need the rendered output (e.g. tests). */
export function executeCommand(input: string, ctx: CommandContext): CommandOutputLine[] {
  return runCommandLine(input, ctx).lines
}
