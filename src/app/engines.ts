// The live, mutable simulation state. These are plain class instances, not
// React/Zustand state — the store (store.ts) only holds a "clock" (tick /
// version counters) plus UI-only state, and every window component reads
// straight from these engines at render time whenever that clock ticks.
// This sidesteps a whole class of stale-reference bugs that come from
// trying to mirror deeply-mutated engine state into a separate reactive
// snapshot.

import { INIT_PID, SHELL_PID, type Process, type ProcessKind } from '../shared/types'
import { SchedulerEngine, createProcess } from '../scheduler/engine'
import { MemoryEngine } from '../memory/engine'
import { FilesystemEngine } from '../filesystem/engine'
import {
  loadFilesystemState,
  saveFilesystemState,
  clearFilesystemState,
  announceFilesystemChange,
  onExternalFilesystemChange,
} from '../filesystem/persistence'
import { SyncEngine } from '../sync/engine'
import { DeadlockEngine } from '../sync/deadlock'
import { NetworkEngine } from '../network/engine'
import { simBus } from '../shared/eventBus'

export const scheduler = new SchedulerEngine()
export const memory = new MemoryEngine()
export const filesystem = new FilesystemEngine()
export const network = new NetworkEngine()
// A module-level singleton like every other engine here, not component
// state — a window/tab being closed or switched away from must never
// discard simulation progress (that's the whole reason every other window
// just reads straight off a shared instance instead of owning its own).
export const deadlock = new DeadlockEngine()

// Reassignable (not const) because "show race condition" / "reset" restart
// this module from scratch rather than mutating it in place — a mode
// switch is a fresh simulation, not a tweak to the running one. ES module
// bindings stay live across reassignment, so every `import { sync }` call
// site still sees the current instance.
export let sync = new SyncEngine(false)

/** Restart the sync module — used by the "show race condition" demo and its reset. */
export function resetSync(unsafe: boolean): void {
  sync = new SyncEngine(unsafe)
}

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

// Swap-to-disk coordinator (roadmap.md §2.1) — the first real integration
// between memory and filesystem. Deliberately lives here, one level above
// both engines, rather than as a dependency either engine takes on the
// other: MemoryEngine only tracks *that* a page is swapped
// (PageTableEntry.swapped) and reports victim/wasSwapped info back from
// access(); this module is what actually turns that into a real file on
// the simulated disk. Same ADR-0004 reasoning as everywhere else in this
// file — engines stay pure singletons that don't know about each other.
const SWAP_PAGE_CONTENT = 'x'.repeat(60) // ~1 block at the default 64-byte block size — one swapped page, one disk block

function swapPath(pid: number, page: number): string {
  return `/swap/${pid}-${page}.swp`
}

// Best-effort: while the filesystem is crashed, every mutation (including
// these) is rejected. Skipping the attempt here just avoids a doomed
// write/delete call; it doesn't (and, given MemoryEngine stays
// filesystem-unaware by design, can't cleanly) reconcile
// PageTableEntry.swapped with what's actually on disk — that flag can
// briefly read "swapped" for a page with no real backing file until it
// next faults, a narrow, self-correcting, and non-crashing edge case
// accepted as a limitation of keeping the two engines decoupled.
function swapOut(pid: number, page: number): void {
  if (filesystem.isCrashed()) return
  filesystem.write(swapPath(pid, page), SWAP_PAGE_CONTENT)
}

function swapIn(pid: number, page: number): void {
  if (filesystem.isCrashed()) return
  filesystem.delete(swapPath(pid, page))
}

/**
 * Deletes every file under /swap. Memory (and with it, which pages are
 * swapped) never persists across reloads — only the filesystem does — so
 * any /swap files hydrated from a previous session are orphaned by
 * construction: nothing in the freshly-booted, empty memory engine still
 * "owns" them. Left in place, a low pid reused after reload could later
 * append fresh swap content onto a stale file instead of writing clean
 * content, since write() is append-only — silently corrupting/growing it
 * across repeated reload+evict cycles.
 */
function clearSwapFiles(): void {
  const result = filesystem.list('/swap')
  if (!result.ok) return
  for (const entry of result.entries) {
    if (entry.type === 'file') filesystem.delete(`/swap/${entry.name}`)
  }
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
  // Read the swapped pages *before* freeProcess() drops the page table —
  // it's the only record of which pages still have a page file to clean up.
  for (const page of memory.getSwappedPages(pid)) swapIn(pid, page)
  memory.freeProcess(pid)
})

// Real filesystem persistence (roadmap.md §1.5) — the disk is the one
// engine that survives a reload. Debounced so a burst of mutations (e.g.
// the scripted demo mode typing several commands in quick succession)
// writes to IndexedDB once, not once per keystroke's worth of state.
const FS_SAVE_DEBOUNCE_MS = 400
let fsSaveTimer: ReturnType<typeof setTimeout> | null = null
// Tracked separately from fsSaveTimer, which is cleared to null the
// moment the timer *fires* — well before the async IndexedDB write it
// kicks off actually completes. Without this, resetFilesystem() calling
// clearFilesystemState() while a save from *before* the reset is still
// in flight is a real race: whichever of the two IndexedDB transactions
// commits last wins, and if it's the stale save, the pre-reset disk gets
// silently resurrected on the next load despite the explicit reset.
let fsSaveInFlight: Promise<void> | null = null

function scheduleFilesystemSave(): void {
  if (fsSaveTimer !== null) clearTimeout(fsSaveTimer)
  fsSaveTimer = setTimeout(() => {
    fsSaveTimer = null
    fsSaveInFlight = saveFilesystemState(filesystem.exportState())
      .then(() => announceFilesystemChange())
      .finally(() => {
        fsSaveInFlight = null
      })
  }, FS_SAVE_DEBOUNCE_MS)
}

simBus.on('fs:mutated', scheduleFilesystemSave)
simBus.on('fs:crashed', scheduleFilesystemSave)
simBus.on('fs:recovered', scheduleFilesystemSave)

// Cross-tab consistency (roadmap-v3.md §2.5) — see the long comment in
// filesystem/persistence.ts for why this exists. A pending local save is
// cancelled first: it would otherwise fire moments later and overwrite
// the just-imported, newer state with this tab's now-stale snapshot.
// Deliberately does not attempt to reconcile MemoryEngine's per-tab
// `swapped` bookkeeping against whatever /swap/* files land in the
// imported tree — memory is tab-local by design (plan.md §2.5) and pids
// are independently numbered per tab, so a swap page file's name can't be
// meaningfully cross-referenced across tabs anyway.
onExternalFilesystemChange(() => {
  if (fsSaveTimer !== null) {
    clearTimeout(fsSaveTimer)
    fsSaveTimer = null
  }
  void (async () => {
    const state = await loadFilesystemState()
    if (state && filesystem.importState(state)) {
      simBus.emit('fs:external-change', {})
    }
  })()
})

/** The `reset-fs` escape hatch — wipes the in-memory disk and its persisted copy. */
export function resetFilesystem(): void {
  filesystem.resetToEmpty() // synchronous — the live engine (what the UI reads) is correct immediately
  if (fsSaveTimer !== null) {
    clearTimeout(fsSaveTimer)
    fsSaveTimer = null
  }
  const inFlight = fsSaveInFlight
  void (async () => {
    // Let any save that had already started finish first, so the clear
    // below is always the last IndexedDB write — see fsSaveInFlight above.
    if (inFlight) await inFlight.catch(() => {})
    await clearFilesystemState()
  })()
}

export function spawnProcess(name: string, kind: ProcessKind = randomKind(), parentPid: number = INIT_PID): Process {
  const process = createProcess(name, kind, undefined, parentPid)
  scheduler.spawn(process)
  memory.allocateProcess(process.pid, process.pageCount)
  simBus.emit('process:spawned', { pid: process.pid, name: process.name, kind: process.kind })
  return process
}

export function killProcess(pid: number): boolean {
  return scheduler.kill(pid) !== undefined
}

/** SIGSTOP / SIGCONT (roadmap-v3.md §2.2) — pause/resume without terminating. */
export function stopProcess(pid: number): boolean {
  return scheduler.stop(pid) !== undefined
}

export function continueProcess(pid: number): boolean {
  return scheduler.cont(pid) !== undefined
}

/**
 * Immediately spawns `count` CPU-bound processes — the terminal's `stress`
 * command (roadmap-v3.md §1.3). Unlike the slow, throttled auto-spawner
 * below, this exists specifically so MLFQ demotion and Clock eviction
 * become visible within a handful of ticks instead of dozens.
 */
export function spawnStressLoad(count: number): Process[] {
  return Array.from({ length: count }, () => spawnProcess(randomName(), 'cpu-bound', SHELL_PID))
}

const AUTO_SPAWN_INTERVAL = 23
const AUTO_SPAWN_CAP = 7

/** Advance the whole simulation by one tick and return what the scheduler ran. */
export function stepSimulation() {
  const result = scheduler.tick()
  filesystem.advanceTick()
  sync.tick()
  network.tick()

  // Whoever is running this tick touches one page of its own address space —
  // this is what actually drives page faults / Clock evictions over time.
  const running = scheduler.getRunning()
  if (running) {
    const page = Math.floor(Math.random() * running.pageCount)
    const isWrite = Math.random() < 0.3 // most memory references are reads
    const access = memory.access(running.pid, page, isWrite)
    if (access.fault) {
      simBus.emit('memory:page-fault', { pid: running.pid, page, victimFrame: access.victimFrame })
      if (access.victim) swapOut(access.victim.pid, access.victim.page)
      if (access.wasSwapped) swapIn(running.pid, page)
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

/**
 * Spawn a handful of processes so the desktop has something running from
 * the first frame. `fromDisk` distinguishes a genuinely fresh disk (write
 * the original boot log line) from one just hydrated from IndexedDB
 * (append a reboot line instead of re-seeding it every reload).
 */
export function bootstrapWorkload(fromDisk = false): void {
  spawnProcess(randomName(), 'interactive')
  spawnProcess(randomName(), 'cpu-bound')
  spawnProcess(randomName(), 'interactive')
  filesystem.write(
    '/var/log/boot.log',
    fromDisk ? 'system rebooted — disk restored from previous session\n' : 'system initialised\n',
  )
}

/**
 * Called once, on app start. Scheduler/memory always reset on reload (see
 * plan.md §2.5) so bootstrapWorkload() always spawns a fresh initial
 * workload; the filesystem is the one engine that persists across reloads
 * (roadmap.md §1.5) via IndexedDB, which is why this is async and hydrates
 * it before bootstrapWorkload() runs.
 */
export async function hydrateAndBootstrap(): Promise<void> {
  const state = await loadFilesystemState()
  const fromDisk = state !== null && filesystem.importState(state)
  if (fromDisk) clearSwapFiles()
  bootstrapWorkload(fromDisk)
}
