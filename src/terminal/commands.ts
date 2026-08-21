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
  fsCrash(): void
  fsFsck(): { replayed: JournalEntry[] }
  fsCrashed(): boolean
  fsReset(): void
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
  '  kill <pid>          terminate a process',
  '  free                memory usage summary',
  '  ls [path]           list a directory (default /), supports * wildcards',
  '  cat <file>           print a file',
  '  write <file> <text>  append text to a file (creates it if missing)',
  '  touch <file>          create an empty file (no-op if it already exists)',
  '  mkdir <dir>           create a directory',
  '  mv <src> <dest>       move/rename a file',
  '  cp <src> <dest>       copy a file',
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
]

/** All command names — exported so the terminal UI can tab-complete against them. */
export const COMMAND_NAMES = [
  'ps',
  'top',
  'run',
  'kill',
  'free',
  'ls',
  'cat',
  'write',
  'touch',
  'mkdir',
  'mv',
  'cp',
  'rm',
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

function normalizePath(path: string | undefined): string {
  if (!path) return '/'
  return path.startsWith('/') ? path : `/${path}`
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
function splitPattern(pathArg: string): { dir: string; pattern: string } {
  const normalized = normalizePath(pathArg)
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

export function executeCommand(input: string, ctx: CommandContext): CommandOutputLine[] {
  const tokens = tokenize(input)
  const [cmd, ...args] = tokens
  if (!cmd) return []

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

    case 'ls': {
      if (args[0]?.includes('*')) {
        const { dir, pattern } = splitPattern(args[0])
        const result = ctx.fsList(dir)
        if (!result.ok) return err(result.error)
        const re = globToRegExp(pattern)
        const matched = result.entries.filter((e) => re.test(e.name))
        if (matched.length === 0) return err(`ls: cannot access '${args[0]}': No such file or directory`)
        return out(matched.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)).join('  '))
      }
      const result = ctx.fsList(normalizePath(args[0]))
      if (!result.ok) return err(result.error)
      if (result.entries.length === 0) return []
      return out(result.entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)).join('  '))
    }

    case 'cat': {
      if (!args[0]) return err('cat: missing file operand')
      const result = ctx.fsRead(normalizePath(args[0]))
      if (!result.ok) return err(result.error)
      return result.content.length === 0 ? [] : out(...result.content.split('\n'))
    }

    case 'write': {
      if (args.length < 2) return err('write: usage: write <file> <text>')
      const [path, ...rest] = args
      const result = ctx.fsWrite(normalizePath(path), rest.join(' '))
      return result.ok ? out(`Wrote to ${normalizePath(path)}.`) : err(result.error)
    }

    case 'rm': {
      if (!args[0]) return err('rm: missing file operand')
      if (args[0].includes('*')) {
        const { dir, pattern } = splitPattern(args[0])
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
      const result = ctx.fsDelete(normalizePath(args[0]))
      return result.ok ? out(`Removed ${normalizePath(args[0])}.`) : err(result.error)
    }

    case 'touch': {
      if (!args[0]) return err('touch: missing file operand')
      const path = normalizePath(args[0])
      if (ctx.fsRead(path).ok) return out(`Touched ${path}.`) // already exists — real touch just bumps mtime, so this is a no-op
      const result = ctx.fsCreate(path)
      return result.ok ? out(`Touched ${path}.`) : err(result.error)
    }

    case 'mkdir': {
      if (!args[0]) return err('mkdir: missing operand')
      const path = normalizePath(args[0])
      const result = ctx.fsMkdir(path)
      return result.ok ? out(`Created directory ${path}.`) : err(result.error)
    }

    case 'mv': {
      if (args.length < 2) return err('mv: usage: mv <src> <dest>')
      const [src, dest] = args
      const result = ctx.fsMove(normalizePath(src), normalizePath(dest))
      return result.ok ? out(`Moved ${normalizePath(src)} -> ${normalizePath(dest)}.`) : err(result.error)
    }

    case 'cp': {
      if (args.length < 2) return err('cp: usage: cp <src> <dest>')
      const [src, dest] = args
      const result = ctx.fsCopy(normalizePath(src), normalizePath(dest))
      return result.ok ? out(`Copied ${normalizePath(src)} -> ${normalizePath(dest)}.`) : err(result.error)
    }

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
