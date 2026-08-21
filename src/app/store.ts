import { create } from 'zustand'
import { SHELL_PID, type TerminalLine } from '../shared/types'
import {
  scheduler,
  memory,
  filesystem,
  sync,
  network,
  spawnProcess,
  spawnStressLoad,
  killProcess,
  stopProcess,
  continueProcess,
  stepSimulation,
  resetSync,
  resetFilesystem,
} from './engines'
import { runCommandLine, type CommandContext } from '../terminal/commands'
import { syscallTraceFor } from '../terminal/syscallTrace'
import { simBus } from '../shared/eventBus'
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
function makeLine(kind: TerminalLine['kind'], text: string, cwd?: string): TerminalLine {
  return { id: lineId++, kind, text, cwd }
}

let syscallLineId = 1
const SYSCALL_LOG_LIMIT = 300

const GANTT_WINDOW = 48

// Full-run Gantt history for the "export this run" feature (roadmap-v3.md
// §3.2) — kept separate from the display-only, 48-wide `ganttLog` above so
// exporting shows the whole run, not just whatever's currently visible in
// the live chart. Capped (not literally unbounded) so an accidentally
// forgotten, days-long open tab can't grow this without limit; at one
// tick per TICK_INTERVAL_MS (450ms), this cap is ~2.5 hours of continuous
// runtime — far beyond any realistic demo session.
const GANTT_HISTORY_CAP = 20000

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
  /** Every tick since boot, for "export this run" — see GANTT_HISTORY_CAP. */
  ganttHistory: (number | null)[]
  /** Real tick number of ganttHistory[0] — 1 until the cap trims the front, then it advances with every trim so exported rows stay labeled with the real tick, not the array index (found by code review). */
  ganttHistoryStartTick: number
  /** Terminal working directory — roadmap-v3.md §1.1. Mutated only via `cd` (through CommandContext.setCwd). */
  cwd: string
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

const WINDOW_IDS = Object.keys(initialWindows) as WindowId[]

// Window layout persistence (roadmap-v3.md §1.4) — cosmetic UI state, so
// localStorage (same medium as terminal history), not IndexedDB (that's
// reserved for the simulated "disk" — see filesystem/persistence.ts).
// Debounced the same way the filesystem save is, so dragging/resizing
// doesn't hit localStorage on every pointermove tick.
const WINDOWS_STORAGE_KEY = 'ossim.windows.layout'
const WINDOWS_SAVE_DEBOUNCE_MS = 400

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isValidWindowState(v: unknown): v is WindowState {
  if (typeof v !== 'object' || v === null) return false
  const w = v as Record<string, unknown>
  return (
    isFiniteNumber(w.x) &&
    isFiniteNumber(w.y) &&
    isFiniteNumber(w.w) &&
    isFiniteNumber(w.h) &&
    isFiniteNumber(w.zIndex) &&
    typeof w.open === 'boolean'
  )
}

// Keeps at least MIN_VISIBLE_PX of a window's titlebar reachable within
// the viewport — without this, dragging (or arrow-key-nudging) a window
// past the edge left it permanently unreachable once window positions
// started persisting (roadmap-v3.md §1.4): before persistence existed, a
// reload silently discarded an off-screen position and fixed it by
// accident; now the exact same off-screen coordinates just get restored
// forever, hiding the window (and its only drag handle) with no "reset
// layout" command exposed (found by code review).
const MIN_VISIBLE_PX = 80

function clampWindowPosition(x: number, y: number, w: number): { x: number; y: number } {
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
  const minX = MIN_VISIBLE_PX - w
  const maxX = Math.max(minX, viewportW - MIN_VISIBLE_PX)
  const maxY = Math.max(0, viewportH - MIN_VISIBLE_PX)
  return { x: Math.min(Math.max(x, minX), maxX), y: Math.min(Math.max(y, 0), maxY) }
}

/**
 * Loads a persisted layout, merged field-by-field onto the defaults: a
 * stored record missing an entry (e.g. a window added in a later build
 * than the one that saved it) or with a malformed one just falls back to
 * that single window's default instead of discarding the whole layout.
 * Positions are re-clamped on load too, in case an already-persisted
 * layout predates clampWindowPosition() above.
 */
function loadWindows(): Record<WindowId, WindowState> {
  try {
    const raw = window.localStorage.getItem(WINDOWS_STORAGE_KEY)
    if (!raw) return initialWindows
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return initialWindows
    const record = parsed as Record<string, unknown>
    const merged = { ...initialWindows }
    for (const id of WINDOW_IDS) {
      const candidate = record[id]
      if (isValidWindowState(candidate)) merged[id] = { ...candidate, ...clampWindowPosition(candidate.x, candidate.y, candidate.w) }
    }
    return merged
  } catch {
    return initialWindows
  }
}

function saveWindows(windows: Record<WindowId, WindowState>): void {
  try {
    window.localStorage.setItem(WINDOWS_STORAGE_KEY, JSON.stringify(windows))
  } catch {
    // localStorage unavailable (private mode / quota) — layout just won't persist, not fatal.
  }
}

export const useSimStore = create<SimStore>((set, get) => ({
  tick: 0,
  version: 0,
  running: true,
  ganttLog: [],
  ganttHistory: [],
  ganttHistoryStartTick: 1,
  cwd: '/',
  syscallLines: [],
  lastAnnouncement: '',
  terminalLines: [
    makeLine('output', 'OS.SIM boot complete — MLFQ scheduler, Clock paging, journaled filesystem online.'),
    makeLine('output', "Type 'help' to see available commands."),
  ],
  windows: loadWindows(),
  focusedWindow: 'scheduler',
  topZ: 3,
  demo: { active: false, typedText: '' },

  toggleRunning: () => set((s) => ({ running: !s.running })),

  stepOnce: () => {
    const result = stepSimulation()
    set((s) => {
      const nextHistory = [...s.ganttHistory, result.sample.pid]
      const overflow = Math.max(0, nextHistory.length - GANTT_HISTORY_CAP)
      return {
        tick: s.tick + 1,
        version: s.version + 1,
        ganttLog: [...s.ganttLog.slice(-(GANTT_WINDOW - 1)), result.sample.pid],
        ganttHistory: overflow > 0 ? nextHistory.slice(overflow) : nextHistory,
        ganttHistoryStartTick: s.ganttHistoryStartTick + overflow,
      }
    })
  },

  runCommand: (input) => {
    const trimmed = input.trim()
    if (!trimmed) return

    if (trimmed === 'clear') {
      set((s) => ({ terminalLines: [], lastAnnouncement: 'screen cleared', version: s.version + 1 }))
      return
    }

    const cwdAtPrompt = get().cwd
    const ctx: CommandContext = {
      listProcesses: () => scheduler.getProcesses(),
      spawnProcess: (name) => spawnProcess(name, undefined, SHELL_PID),
      spawnStress: (n) => spawnStressLoad(n),
      killProcess: (pid) => killProcess(pid),
      stopProcess: (pid) => stopProcess(pid),
      contProcess: (pid) => continueProcess(pid),
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
      fsLink: (target, link) => filesystem.link(target, link),
      fsChmod: (path, mode) => filesystem.chmod(path, mode),
      fsCrash: () => filesystem.crash(),
      fsFsck: () => filesystem.fsck(),
      fsCrashed: () => filesystem.isCrashed(),
      fsReset: () => resetFilesystem(),
      getCwd: () => get().cwd,
      setCwd: (path) => set({ cwd: path }),
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

    const { lines: output, ran } = runCommandLine(trimmed, ctx)
    const trace = ran
      .flatMap(({ text, ok, cwd }) => syscallTraceFor(text, ok, cwd))
      .map((text) => ({ id: syscallLineId++, text }))
    set((s) => ({
      terminalLines: [
        ...s.terminalLines,
        makeLine('prompt', trimmed, cwdAtPrompt),
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
    set((s) => {
      const win = s.windows[id]!
      return { windows: { ...s.windows, [id]: { ...win, ...clampWindowPosition(x, y, win.w) } } }
    }),

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

let windowsSaveTimer: ReturnType<typeof setTimeout> | null = null
useSimStore.subscribe((state, prevState) => {
  if (state.windows === prevState.windows) return
  if (windowsSaveTimer !== null) clearTimeout(windowsSaveTimer)
  windowsSaveTimer = setTimeout(() => saveWindows(state.windows), WINDOWS_SAVE_DEBOUNCE_MS)
})

// Cross-tab filesystem consistency (roadmap-v3.md §2.5) — app/engines.ts
// already re-hydrated the live FilesystemEngine singleton by this point;
// this just makes the change visible (bump `version` so every subscribed
// window re-renders) and surfaces it in the terminal, so what's otherwise
// a silent background reconciliation is actually observable/demoable.
simBus.on('fs:external-change', () => {
  useSimStore.setState((s) => ({
    version: s.version + 1,
    terminalLines: [...s.terminalLines, makeLine('output', '[SYNC] filesystem updated from another tab.')],
    lastAnnouncement: 'filesystem updated from another tab',
  }))
})
