// The live, mutable simulation state. These are plain class instances, not
// React/Zustand state — the store (store.ts) only holds a "clock" (tick /
// version counters) plus UI-only state, and every window component reads
// straight from these engines at render time whenever that clock ticks.
// This sidesteps a whole class of stale-reference bugs that come from
// trying to mirror deeply-mutated engine state into a separate reactive
// snapshot.

import type { Process, ProcessKind } from '../shared/types'
import { SchedulerEngine, createProcess } from '../scheduler/engine'
import { MemoryEngine } from '../memory/engine'
import { FilesystemEngine } from '../filesystem/engine'
import { simBus } from '../shared/eventBus'

export const scheduler = new SchedulerEngine()
export const memory = new MemoryEngine()
export const filesystem = new FilesystemEngine()

// A couple of frames "reserved" for the kernel so the RAM grid looks like a
// real machine's memory map from the very first render.
memory.reserveKernelFrames(2)

const PROCESS_NAME_POOL = [
  'compiler',
  'browser',
  'indexer',
  'backupd',
  'renderer',
  'logger',
  'monitor',
  'shelld',
  'updater',
  'cached',
]

function randomName(): string {
  return PROCESS_NAME_POOL[Math.floor(Math.random() * PROCESS_NAME_POOL.length)]!
}

function randomKind(): ProcessKind {
  return Math.random() < 0.55 ? 'interactive' : 'cpu-bound'
}

const memoryFreed = new Set<number>()

export function spawnProcess(name: string, kind: ProcessKind = randomKind()): Process {
  const process = createProcess(name, kind)
  scheduler.spawn(process)
  memory.allocateProcess(process.pid, process.pageCount)
  simBus.emit('process:spawned', { pid: process.pid, name: process.name, kind: process.kind })
  return process
}

export function killProcess(pid: number): boolean {
  const process = scheduler.kill(pid)
  if (!process) return false
  memory.freeProcess(pid)
  memoryFreed.add(pid)
  simBus.emit('process:terminated', { pid, name: process.name, reason: 'killed' })
  return true
}

const AUTO_SPAWN_INTERVAL = 23
const AUTO_SPAWN_CAP = 7

/** Advance the whole simulation by one tick and return what the scheduler ran. */
export function stepSimulation() {
  const result = scheduler.tick()
  filesystem.advanceTick()

  // A process can finish on its own (burst exhausted) without ever going
  // through kill() — still needs its memory released exactly once.
  for (const process of scheduler.getProcesses()) {
    if (process.state === 'TERMINATED' && !memoryFreed.has(process.pid)) {
      memory.freeProcess(process.pid)
      memoryFreed.add(process.pid)
      simBus.emit('process:terminated', { pid: process.pid, name: process.name, reason: 'natural' })
    }
  }

  // Whoever is running this tick touches one page of its own address space —
  // this is what actually drives page faults / Clock evictions over time.
  const running = scheduler.getRunning()
  if (running) {
    const page = Math.floor(Math.random() * running.pageCount)
    const access = memory.access(running.pid, page)
    if (access.fault) {
      simBus.emit('memory:page-fault', { pid: running.pid, page, victimFrame: access.victimFrame })
    }
  }

  // Automatic, self-sustaining workload — see plan.md §2.1. Caps out so a
  // long-running demo doesn't grow the process list forever.
  const active = scheduler.getProcesses().filter((p) => p.state !== 'TERMINATED').length
  if (active < AUTO_SPAWN_CAP && result.tick % AUTO_SPAWN_INTERVAL === 0) {
    spawnProcess(randomName())
  }

  return result
}

/** Spawn a handful of processes so the desktop has something running from the first frame. */
export function bootstrapWorkload(): void {
  spawnProcess(randomName(), 'interactive')
  spawnProcess(randomName(), 'cpu-bound')
  spawnProcess(randomName(), 'interactive')
  filesystem.write('/var/log/boot.log', 'system initialised\n')
}
