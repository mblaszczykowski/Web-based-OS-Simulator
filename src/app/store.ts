import { create } from 'zustand'
import { SHELL_PID, type TerminalLine } from '../shared/types'
import {
  scheduler,
  memory,
  filesystem,
  sync,
  network,
  spawnProcess,
  killProcess,
  stepSimulation,
  resetSync,
  resetFilesystem,
} from './engines'
import { executeCommand, type CommandContext } from '../terminal/commands'
import { syscallTraceFor } from '../terminal/syscallTrace'
import { SYNC_BUFFER_CAPACITY } from '../sync/engine'

export type WindowId = 'scheduler' | 'memory' | 'filesystem' | 'terminal' | 'syscalls' | 'sync' | 'network'

export interface WindowState {
  x: number
  y: number
  w: number
  h: number
  open: boolean
  zIndex: number
}

export interface SyscallLine {
  id: number
  text: string
}

export interface DemoState {
  active: boolean
  /** What the typewriter effect has "typed" into the terminal input so far, for the current step. */
  typedText: string
}

let lineId = 1
function makeLine(kind: TerminalLine['kind'], text: string): TerminalLine {
  return { id: lineId++, kind, text }
}

let syscallLineId = 1
const SYSCALL_LOG_LIMIT = 300

const GANTT_WINDOW = 48

// Scripted auto-demo — roadmap.md §1.1. Solves the "recruiter opens the
// live demo and doesn't know what to type" problem by typing and running a
// fixed tour through every subsystem. `command` can be a thunk because the
// `kill` step needs a real pid that only exists once `run compiler` (an
// earlier step) has actually executed.
interface DemoStep {
  command: string | (() => string | null)
  pauseAfterMs: number
}

const DEMO_TYPE_CHAR_MS = 45
const DEMO_STEPS: DemoStep[] = [
  { command: 'ps', pauseAfterMs: 1100 },
  { command: 'run compiler', pauseAfterMs: 1300 },
  { command: 'top', pauseAfterMs: 1100 },
  { command: 'write /notes.txt hello', pauseAfterMs: 900 },
  { command: 'cat /notes.txt', pauseAfterMs: 1300 },
  { command: 'crash', pauseAfterMs: 1700 },
  { command: 'fsck', pauseAfterMs: 1700 },
  {
    command: () => {
      const compiler = scheduler
        .getProcesses()
        .filter((p) => p.name === 'compiler' && p.state !== 'TERMINATED')
        .pop()
      return compiler ? `kill ${compiler.pid}` : null
    },
    pauseAfterMs: 1200,
  },
]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
/** Bumped by stopDemo()/a fresh startDemo() so an in-flight demo loop can tell it's been superseded and bail out. */
let demoToken = 0

interface SimStore {
  /** Simulation clock — only advances one per stepOnce(). Drives the Gantt x-axis. */
  tick: number
  /** Bumped on *any* mutation (tick or terminal command) — the signal every window subscribes to. */
  version: number
  running: boolean
  ganttLog: (number | null)[]
  terminalLines: TerminalLine[]
  syscallLines: SyscallLine[]
  /** Full text of the most recently run command's output, for the terminal's aria-live region — see runCommand(). */
  lastAnnouncement: string
  windows: Record<WindowId, WindowState>
  focusedWindow: WindowId | null
  topZ: number
  demo: DemoState

  toggleRunning: () => void
  stepOnce: () => void
  runCommand: (input: string) => void
  focusWindow: (id: WindowId) => void
  closeWindow: (id: WindowId) => void
  openWindow: (id: WindowId) => void
  moveWindow: (id: WindowId, x: number, y: number) => void
  resizeWindow: (id: WindowId, w: number, h: number) => void
  startDemo: () => Promise<void>
  stopDemo: () => void
}

const initialWindows: Record<WindowId, WindowState> = {
  scheduler: { x: 32, y: 48, w: 740, h: 580, open: true, zIndex: 3 },
  memory: { x: 800, y: 48, w: 560, h: 340, open: true, zIndex: 2 },
  terminal: { x: 800, y: 408, w: 560, h: 380, open: true, zIndex: 2 },
  filesystem: { x: 140, y: 110, w: 780, h: 580, open: false, zIndex: 1 },
  syscalls: { x: 220, y: 150, w: 460, h: 320, open: false, zIndex: 1 },
  sync: { x: 180, y: 90, w: 720, h: 560, open: false, zIndex: 1 },
  network: { x: 260, y: 180, w: 520, h: 400, open: false, zIndex: 1 },
}

export const useSimStore = create<SimStore>((set, get) => ({
  tick: 0,
  version: 0,
  running: true,
  ganttLog: [],
  syscallLines: [],
  lastAnnouncement: '',
  terminalLines: [
    makeLine('output', 'OS.SIM boot complete — MLFQ scheduler, Clock paging, journaled filesystem online.'),
    makeLine('output', "Type 'help' to see available commands."),
  ],
  windows: initialWindows,
  focusedWindow: 'scheduler',
  topZ: 3,
  demo: { active: false, typedText: '' },

  toggleRunning: () => set((s) => ({ running: !s.running })),

  stepOnce: () => {
    const result = stepSimulation()
    set((s) => ({
      tick: s.tick + 1,
      version: s.version + 1,
      ganttLog: [...s.ganttLog.slice(-(GANTT_WINDOW - 1)), result.sample.pid],
    }))
  },

  runCommand: (input) => {
    const trimmed = input.trim()
    if (!trimmed) return

    if (trimmed === 'clear') {
      set((s) => ({ terminalLines: [], lastAnnouncement: 'screen cleared', version: s.version + 1 }))
      return
    }

    const ctx: CommandContext = {
      listProcesses: () => scheduler.getProcesses(),
      spawnProcess: (name) => spawnProcess(name, undefined, SHELL_PID),
      killProcess: (pid) => killProcess(pid),
      schedulerMetrics: () => scheduler.getMetrics(),
      memoryMetrics: () => {
        const m = memory.getMetrics()
        const frames = memory.getFrames()
        return { ...m, frameCount: frames.length, usedFrames: frames.filter((f) => f.owner !== null).length }
      },
      fsList: (path) => filesystem.list(path),
      fsRead: (path) => filesystem.read(path),
      fsCreate: (path) => filesystem.create(path),
      fsWrite: (path, text) => filesystem.write(path, text),
      fsDelete: (path) => filesystem.delete(path),
      fsMkdir: (path) => filesystem.mkdir(path),
      fsMove: (src, dest) => filesystem.move(src, dest),
      fsCopy: (src, dest) => filesystem.copy(src, dest),
      fsCrash: () => filesystem.crash(),
      fsFsck: () => filesystem.fsck(),
      fsCrashed: () => filesystem.isCrashed(),
      fsReset: () => resetFilesystem(),
      syncStatus: () => {
        const m = sync.getMetrics()
        return {
          capacity: SYNC_BUFFER_CAPACITY,
          occupancy: m.realOccupancy,
          mutexLocked: m.mutexLocked,
          producedTotal: m.producedTotal,
          consumedTotal: m.consumedTotal,
          corruptionEvents: m.corruptionEvents,
          unsafe: sync.unsafe,
        }
      },
      syncSetUnsafe: (unsafe) => resetSync(unsafe),
      networkPing: (host) => network.ping(host),
      networkCurl: (host) => network.curl(host),
    }

    const output = executeCommand(trimmed, ctx)
    const ok = output.every((line) => !line.isError)
    const trace = syscallTraceFor(trimmed, ok).map((text) => ({ id: syscallLineId++, text }))
    set((s) => ({
      terminalLines: [
        ...s.terminalLines,
        makeLine('prompt', trimmed),
        ...output.map((line) => makeLine(line.isError ? 'error' : 'output', line.text)),
      ],
      syscallLines: [...s.syscallLines, ...trace].slice(-SYSCALL_LOG_LIMIT),
      // The terminal's aria-live region reads this, not individual
      // lines — a screen-reader user needs the *whole* result of a
      // command like `ps`/`fsck` (many lines), not just whichever line
      // happened to render last.
      lastAnnouncement: [trimmed, ...output.map((line) => line.text)].join('. '),
      version: s.version + 1,
    }))
  },

  focusWindow: (id) =>
    set((s) => {
      const zIndex = s.topZ + 1
      return {
        focusedWindow: id,
        topZ: zIndex,
        windows: { ...s.windows, [id]: { ...s.windows[id]!, open: true, zIndex } },
      }
    }),

  closeWindow: (id) =>
    set((s) => ({
      windows: { ...s.windows, [id]: { ...s.windows[id]!, open: false } },
      focusedWindow: s.focusedWindow === id ? null : s.focusedWindow,
    })),

  openWindow: (id) => get().focusWindow(id),

  moveWindow: (id, x, y) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id]!, x, y } } })),

  resizeWindow: (id, w, h) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id]!, w, h } } })),

  startDemo: async () => {
    if (get().demo.active) return
    const token = ++demoToken
    const cancelled = () => demoToken !== token

    set({ demo: { active: true, typedText: '' } })
    get().focusWindow('terminal')

    // write() is append-only (matches the real terminal command), and the
    // disk now persists across reloads (roadmap.md §1.5) — so without
    // this, watching the demo more than once in a session, or after a
    // reload, would show /notes.txt accumulating "hellohellohello..."
    // instead of the clean "hello" the `cat` step is meant to display.
    // Silent (not one of DEMO_STEPS) so a first-ever run doesn't show a
    // spurious "No such file" error before the file has ever existed.
    filesystem.delete('/notes.txt')

    for (const step of DEMO_STEPS) {
      if (cancelled()) return
      const command = typeof step.command === 'function' ? step.command() : step.command
      if (!command) continue

      for (let i = 0; i <= command.length; i++) {
        if (cancelled()) return
        set({ demo: { active: true, typedText: command.slice(0, i) } })
        await sleep(DEMO_TYPE_CHAR_MS)
      }
      await sleep(280)
      if (cancelled()) return

      get().runCommand(command)
      set({ demo: { active: true, typedText: '' } })
      await sleep(step.pauseAfterMs)
    }

    if (!cancelled()) set({ demo: { active: false, typedText: '' } })
  },

  stopDemo: () => {
    demoToken++
    set({ demo: { active: false, typedText: '' } })
  },
}))
