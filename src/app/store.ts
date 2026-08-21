import { create } from 'zustand'
import type { TerminalLine } from '../shared/types'
import { scheduler, memory, filesystem, spawnProcess, killProcess, stepSimulation } from './engines'
import { executeCommand, type CommandContext } from '../terminal/commands'

export type WindowId = 'scheduler' | 'memory' | 'filesystem' | 'terminal'

export interface WindowState {
  x: number
  y: number
  w: number
  h: number
  open: boolean
  zIndex: number
}

let lineId = 1
function makeLine(kind: TerminalLine['kind'], text: string): TerminalLine {
  return { id: lineId++, kind, text }
}

const GANTT_WINDOW = 48

interface SimStore {
  /** Simulation clock — only advances one per stepOnce(). Drives the Gantt x-axis. */
  tick: number
  /** Bumped on *any* mutation (tick or terminal command) — the signal every window subscribes to. */
  version: number
  running: boolean
  ganttLog: (number | null)[]
  terminalLines: TerminalLine[]
  windows: Record<WindowId, WindowState>
  focusedWindow: WindowId | null
  topZ: number

  toggleRunning: () => void
  stepOnce: () => void
  runCommand: (input: string) => void
  focusWindow: (id: WindowId) => void
  closeWindow: (id: WindowId) => void
  openWindow: (id: WindowId) => void
  moveWindow: (id: WindowId, x: number, y: number) => void
}

const initialWindows: Record<WindowId, WindowState> = {
  scheduler: { x: 32, y: 48, w: 740, h: 580, open: true, zIndex: 3 },
  memory: { x: 800, y: 48, w: 560, h: 340, open: true, zIndex: 2 },
  terminal: { x: 800, y: 408, w: 560, h: 380, open: true, zIndex: 2 },
  filesystem: { x: 140, y: 110, w: 780, h: 580, open: false, zIndex: 1 },
}

export const useSimStore = create<SimStore>((set, get) => ({
  tick: 0,
  version: 0,
  running: true,
  ganttLog: [],
  terminalLines: [
    makeLine('output', 'OS.SIM boot complete — MLFQ scheduler, Clock paging, journaled filesystem online.'),
    makeLine('output', "Type 'help' to see available commands."),
  ],
  windows: initialWindows,
  focusedWindow: 'scheduler',
  topZ: 3,

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
      set((s) => ({ terminalLines: [], version: s.version + 1 }))
      return
    }

    const ctx: CommandContext = {
      listProcesses: () => scheduler.getProcesses(),
      spawnProcess: (name) => spawnProcess(name),
      killProcess: (pid) => killProcess(pid),
      schedulerMetrics: () => scheduler.getMetrics(),
      memoryMetrics: () => {
        const m = memory.getMetrics()
        const frames = memory.getFrames()
        return { ...m, frameCount: frames.length, usedFrames: frames.filter((f) => f.owner !== null).length }
      },
      fsList: (path) => filesystem.list(path),
      fsRead: (path) => filesystem.read(path),
      fsWrite: (path, text) => filesystem.write(path, text),
      fsDelete: (path) => filesystem.delete(path),
      fsCrash: () => filesystem.crash(),
      fsFsck: () => filesystem.fsck(),
      fsCrashed: () => filesystem.isCrashed(),
    }

    const output = executeCommand(trimmed, ctx)
    set((s) => ({
      terminalLines: [
        ...s.terminalLines,
        makeLine('prompt', trimmed),
        ...output.map((line) => makeLine(line.toLowerCase().includes('error') ? 'error' : 'output', line)),
      ],
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

  closeWindow: (id) => set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id]!, open: false } } })),

  openWindow: (id) => get().focusWindow(id),

  moveWindow: (id, x, y) =>
    set((s) => ({ windows: { ...s.windows, [id]: { ...s.windows[id]!, x, y } } })),
}))
