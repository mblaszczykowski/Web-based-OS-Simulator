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
  fsWrite(path: string, text: string): { ok: true } | { ok: false; error: string }
  fsDelete(path: string): { ok: true } | { ok: false; error: string }
  fsCrash(): void
  fsFsck(): { replayed: JournalEntry[] }
  fsCrashed(): boolean
}

const HELP_TEXT = [
  'Available commands:',
  '  ps                 list processes',
  '  top                live scheduler summary',
  '  run <name>          spawn a new process',
  '  kill <pid>          terminate a process',
  '  free                memory usage summary',
  '  ls [path]           list a directory (default /)',
  '  cat <file>           print a file',
  '  write <file> <text>  append text to a file (creates it if missing)',
  '  rm <file>            delete a file',
  '  crash               simulate a power loss mid-write',
  '  fsck                replay the journal and recover the filesystem',
  '  clear                clear the screen',
  '  help                 show this message',
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

export function executeCommand(input: string, ctx: CommandContext): string[] {
  const tokens = tokenize(input)
  const [cmd, ...args] = tokens
  if (!cmd) return []

  switch (cmd) {
    case 'help':
      return HELP_TEXT

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
      return [header, ...rows]
    }

    case 'top': {
      const m = ctx.schedulerMetrics()
      const procs = ctx.listProcesses()
      const running = procs.filter((p) => p.state === 'RUNNING').length
      const ready = procs.filter((p) => p.state === 'READY').length
      const waiting = procs.filter((p) => p.state === 'WAITING').length
      return [
        `CPU: ${pct(m.cpuUtilization)}  Procs: ${procs.length} (${running} running, ${ready} ready, ${waiting} waiting)`,
        `Avg waiting: ${m.avgWaitingTicks.toFixed(1)} ticks  Avg turnaround: ${m.avgTurnaroundTicks.toFixed(1)} ticks  Ctx switches: ${m.contextSwitches}`,
      ]
    }

    case 'run': {
      const name = args.join(' ') || `proc${Math.floor(Math.random() * 1000)}`
      const process = ctx.spawnProcess(name)
      return [`Started process ${process.pid} (${process.name}).`]
    }

    case 'kill': {
      const pid = Number(args[0])
      if (!args[0] || Number.isNaN(pid)) return [`kill: usage: kill <pid>`]
      const ok = ctx.killProcess(pid)
      return ok ? [`Process ${pid} terminated.`] : [`kill: (${pid}) - No such process`]
    }

    case 'free': {
      const m = ctx.memoryMetrics()
      return [
        `Frames: ${m.usedFrames}/${m.frameCount} used`,
        `Page faults: ${m.pageFaults}  Accesses: ${m.accesses}  Hit ratio: ${pct(m.hitRatio)}`,
        `External fragmentation (contiguous arena): ${pct(m.externalFragmentation)}`,
      ]
    }

    case 'ls': {
      const result = ctx.fsList(normalizePath(args[0]))
      if (!result.ok) return [result.error]
      if (result.entries.length === 0) return []
      return [result.entries.map((e) => (e.type === 'dir' ? `${e.name}/` : e.name)).join('  ')]
    }

    case 'cat': {
      if (!args[0]) return ['cat: missing file operand']
      const result = ctx.fsRead(normalizePath(args[0]))
      if (!result.ok) return [result.error]
      return result.content.length === 0 ? [] : result.content.split('\n')
    }

    case 'write': {
      if (args.length < 2) return ['write: usage: write <file> <text>']
      const [path, ...rest] = args
      const result = ctx.fsWrite(normalizePath(path), rest.join(' '))
      return result.ok ? [`Wrote to ${normalizePath(path)}.`] : [result.error]
    }

    case 'rm': {
      if (!args[0]) return ['rm: missing file operand']
      const result = ctx.fsDelete(normalizePath(args[0]))
      return result.ok ? [`Removed ${normalizePath(args[0])}.`] : [result.error]
    }

    case 'crash': {
      ctx.fsCrash()
      return ['[CRASH] power loss — pending write left in the journal. Run `fsck` to recover.']
    }

    case 'fsck': {
      const { replayed } = ctx.fsFsck()
      if (replayed.length === 0) return ['[FSCK] journal clean, nothing to replay.']
      const lines = ['[FSCK] scanning journal…']
      for (const entry of replayed) {
        lines.push(`[REPLAY] ${entry.op} ${entry.path} → committed`)
      }
      lines.push('[OK] filesystem consistent')
      return lines
    }

    case 'clear':
      return []

    default:
      return [`command not found: ${cmd}`]
  }
}
