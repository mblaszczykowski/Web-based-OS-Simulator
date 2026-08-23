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
  spawnThreadGroup,
  spawnPipeline,
  forkProcess,
  pipes,
  fdTable,
  killProcess,
  stopProcess,
  continueProcess,
  stepSimulation,
  resetSync,
  resetFilesystem,
} from './engines'
import { runCommandLine, type CommandContext } from '../terminal/commands'
import { DEFAULT_FS_CONFIG } from '../filesystem/engine'
import { traceSyscalls } from '../kernel/syscalls'
import { STANDARD_STREAMS } from '../kernel/fdTable'
import { simBus } from '../shared/eventBus'
import { writeSharedSessionState } from './urlState'
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
  typedText: string
}

let lineId = 1
function makeLine(kind: TerminalLine['kind'], text: string, cwd?: string): TerminalLine {
  return { id: lineId++, kind, text, cwd }
}

let syscallLineId = 1
const SYSCALL_LOG_LIMIT = 300

const GANTT_WINDOW = 48

const GANTT_HISTORY_CAP = 20000

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
let demoToken = 0

interface SimStore {
  tick: number
  version: number
  running: boolean
  ganttLog: (number | null)[][]
  ganttHistory: (number | null)[][]
  ganttHistoryStartTick: number
  cwd: string
  env: Record<string, string>
  terminalLines: TerminalLine[]
  syscallLines: SyscallLine[]
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

const MIN_VISIBLE_PX = 80

function clampWindowPosition(x: number, y: number, w: number): { x: number; y: number } {
  const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1280
  const viewportH = typeof window !== 'undefined' ? window.innerHeight : 800
  const minX = MIN_VISIBLE_PX - w
  const maxX = Math.max(minX, viewportW - MIN_VISIBLE_PX)
  const maxY = Math.max(0, viewportH - MIN_VISIBLE_PX)
  return { x: Math.min(Math.max(x, minX), maxX), y: Math.min(Math.max(y, 0), maxY) }
}

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
    // localStorage unavailable (private mode, quota) — layout just won't persist.
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
  env: {},
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
      const nextHistory = [...s.ganttHistory, result.sample.pids]
      const overflow = Math.max(0, nextHistory.length - GANTT_HISTORY_CAP)
      return {
        tick: s.tick + 1,
        version: s.version + 1,
        ganttLog: [...s.ganttLog.slice(-(GANTT_WINDOW - 1)), result.sample.pids],
        ganttHistory: overflow > 0 ? nextHistory.slice(overflow) : nextHistory,
        ganttHistoryStartTick: s.ganttHistoryStartTick + overflow,
      }
    })
  },

  runCommand: (input) => {
    const trimmed = input.trim()
    if (!trimmed) return

    const cwdAtPrompt = get().cwd
    const ctx: CommandContext = {
      listProcesses: () => scheduler.getProcesses(),
      spawnProcess: (name) => spawnProcess(name, undefined, SHELL_PID),
      spawnStress: (n) => spawnStressLoad(n),
      spawnThreads: (name, n) => spawnThreadGroup(name, n, SHELL_PID),
      spawnPipeline: (writerName, readerName) => spawnPipeline(writerName, readerName, SHELL_PID),
      forkProcess: (pid) => forkProcess(pid),
      openFiles: () => {
        const rows: { pid: number; processName: string; fd: number; kind: string; target: string }[] = []
        for (const process of scheduler.getProcesses()) {
          if (process.state === 'TERMINATED') continue
          for (const stream of STANDARD_STREAMS) {
            rows.push({ pid: process.pid, processName: process.name, fd: stream.fd, kind: stream.name, target: '/dev/tty' })
          }
          for (const descriptor of fdTable.forPid(process.pid)) {
            rows.push({ pid: process.pid, processName: process.name, fd: descriptor.fd, kind: descriptor.kind, target: descriptor.target })
          }
        }
        return rows.sort((a, b) => a.pid - b.pid || a.fd - b.fd)
      },
      pipeStatus: () =>
        pipes.getPipes().map((p) => ({
          id: p.id,
          writerPid: p.writerPid,
          readerPid: p.readerPid,
          occupancy: p.buffer.length,
          capacity: p.capacity,
          writtenTotal: p.writtenTotal,
          readTotal: p.readTotal,
          writerOpen: p.writerOpen,
          readerOpen: p.readerOpen,
        })),
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
      fsSymlink: (target, link) => filesystem.symlink(target, link),
      fsChmod: (path, mode) => filesystem.chmod(path, mode),
      fsCrash: () => filesystem.crash(),
      fsFsck: () => filesystem.fsck(),
      fsCrashed: () => filesystem.isCrashed(),
      fsReset: () => resetFilesystem(),
      fsUsage: () => {
        const m = filesystem.getMetrics()
        return {
          totalBlocks: m.totalBlocks,
          usedBlocks: m.usedBlocks,
          freeBlocks: m.freeBlocks,
          blockSizeBytes: DEFAULT_FS_CONFIG.blockSizeBytes,
          bitmap: filesystem.getFreeSpaceBitmap(),
        }
      },
      ioMetrics: () => {
        const m = filesystem.getIoMetrics()
        return {
          cylinderCount: m.cylinderCount,
          headPosition: m.headPosition,
          pendingCount: m.pendingCount,
          completedCount: m.completedCount,
          avgSeekDistance: m.avgSeekDistance,
          avgWaitTicks: m.avgWaitTicks,
        }
      },
      getCwd: () => get().cwd,
      setCwd: (path) => set({ cwd: path }),
      getEnv: (name) => (Object.hasOwn(get().env, name) ? get().env[name] : undefined),
      setEnv: (name, value) => set((s) => ({ env: { ...s.env, [name]: value } })),
      listEnv: () => get().env,
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
      syncSetUnsafe: (unsafe) => {
        resetSync(unsafe)
        writeSharedSessionState({ raceOn: unsafe })
      },
      networkPing: (host) => network.ping(host),
      networkCurl: (host) => network.curl(host),
    }

    const tracer = traceSyscalls(ctx, fdTable)
    const output = runCommandLine(trimmed, tracer.ctx)
    const trace = tracer.drain().map((text) => ({ id: syscallLineId++, text }))

    const lastClearIndex = output.reduce((acc, line, i) => (line.clearScreen ? i : acc), -1)
    const visible = lastClearIndex === -1 ? output : output.slice(lastClearIndex + 1)

    set((s) => ({
      terminalLines:
        lastClearIndex === -1
          ? [
              ...s.terminalLines,
              makeLine('prompt', trimmed, cwdAtPrompt),
              ...visible.map((line) => makeLine(line.isError ? 'error' : 'output', line.text)),
            ]
          : visible.map((line) => makeLine(line.isError ? 'error' : 'output', line.text)),
      syscallLines: [...s.syscallLines, ...trace].slice(-SYSCALL_LOG_LIMIT),
      lastAnnouncement:
        lastClearIndex === -1
          ? [trimmed, ...output.map((line) => line.text)].join('. ')
          : (visible.length > 0 ? visible.map((line) => line.text).join('. ') : 'screen cleared'),
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

simBus.on('fs:external-change', () => {
  useSimStore.setState((s) => ({
    version: s.version + 1,
    terminalLines: [...s.terminalLines, makeLine('output', '[SYNC] filesystem updated from another tab.')],
    lastAnnouncement: 'filesystem updated from another tab',
  }))
})
