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

// SchedulerEngine emits `process:terminated` exactly once per process,
// from the single choke point where its state actually flips to
// TERMINATED (kill() or the natural-completion branch of tick()) — so
// freeing its memory can just be a subscriber here instead of every
// termination call site having to remember to do it (and de-dupe against
// doing it twice). This is the event bus plan.md §5 actually describes —
// scheduler and memory stay decoupled through it, not through this
// module knowing both engines' internals.
simBus.on('process:terminated', ({ pid }) => {
  memory.freeProcess(pid)
})

export function spawnProcess(name: string, kind: ProcessKind = randomKind()): Process {
  const process = createProcess(name, kind)
  scheduler.spawn(process)
  memory.allocateProcess(process.pid, process.pageCount)
  simBus.emit('process:spawned', { pid: process.pid, name: process.name, kind: process.kind })
  return process
}

export function killProcess(pid: number): boolean {
  return scheduler.kill(pid) !== undefined
}

const AUTO_SPAWN_INTERVAL = 23
const AUTO_SPAWN_CAP = 7

/** Advance the whole simulation by one tick and return what the scheduler ran. */
export function stepSimulation() {
  const result = scheduler.tick()
  filesystem.advanceTick()

  // Whoever is running this tick touches one page of its own address space —
  // this is what actually drives page faults / Clock evictions over time.
  const running = scheduler.getRunning()
  if (running) {
    const page = Math.floor(Math.random() * running.pageCount)
    const isWrite = Math.random() < 0.3 // most memory references are reads
    const access = memory.access(running.pid, page, isWrite)
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

/**
 * Called once, on app start. Scheduler/memory always reset on reload (see
 * plan.md §2.5) so bootstrapWorkload() always spawns a fresh initial
 * workload; the filesystem is the one engine that will eventually persist
 * across reloads (roadmap.md §1.5), which is why this is async and lives
 * separately from the synchronous bootstrapWorkload() above.
 */
export async function hydrateAndBootstrap(): Promise<void> {
  bootstrapWorkload()
}
