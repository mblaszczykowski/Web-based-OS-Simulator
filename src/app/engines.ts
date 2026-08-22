// The live, mutable simulation state. These are plain class instances, not
// React/Zustand state — the store (store.ts) only holds a "clock" (tick /
// version counters) plus UI-only state, and every window component reads
// straight from these engines at render time whenever that clock ticks.
// This sidesteps a whole class of stale-reference bugs that come from
// trying to mirror deeply-mutated engine state into a separate reactive
// snapshot.

import { INIT_PID, SHELL_PID, type Process, type ProcessKind } from '../shared/types'
import { SchedulerEngine, createProcess, generateBursts } from '../scheduler/engine'
import { MemoryEngine } from '../memory/engine'
import { FilesystemEngine, DEFAULT_FS_CONFIG } from '../filesystem/engine'
import {
  loadFilesystemState,
  saveFilesystemState,
  clearFilesystemState,
  announceFilesystemChange,
  onExternalFilesystemChange,
} from '../filesystem/persistence'
import { SyncEngine } from '../sync/engine'
import { DeadlockEngine } from '../sync/deadlock'
import { BankerEngine } from '../sync/banker'
import { NetworkEngine } from '../network/engine'
import { PipeEngine } from '../ipc/pipe'
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
// Deadlock *avoidance* (roadmap-v3.md §3.1) — sits alongside `deadlock`
// (detection) as a second, independent extension of the sync module, same
// singleton-per-module pattern as every other engine here.
export const banker = new BankerEngine()
// Anonymous pipes (roadmap-v5.md §1.2) — a singleton like every other
// engine. Owns the channels only; who blocks on them is the scheduler's
// business, coordinated below.
export const pipes = new PipeEngine()

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

// --------------------------------------------------------------------------
// Real I/O blocking (roadmap-v5.md §1.1) — the second real integration
// between two engines, built the same way as swap: neither engine imports
// the other, and this module is the only place that knows both exist
// (ADR-0004).
//
// Before this, the simulator held two unrelated notions of "I/O": the
// scheduler counted an I/O burst down by itself, while the filesystem's
// SCAN queue was fed purely by file operations. A process in WAITING never
// moved the disk head, and `iostat` and the Gantt chart described two
// disconnected worlds. Now the scheduler hands its I/O burst to the disk
// and the process stays blocked until the head actually reaches it.
//
// Which cylinder a process asks for is drawn uniformly at random. A real
// process's I/O targets its own file's blocks, but this simulator's
// synthetic workload (`run compiler`) owns no files — and a uniformly
// random request stream over the cylinders is exactly the reference
// workload SCAN is judged against in the textbook, so it's the honest
// stand-in rather than a shortcut.
scheduler.setIoPort({
  submit(pid) {
    // A crashed disk rejects everything until `fsck`. Declining here (so
    // the scheduler falls back to its self-timed countdown) rather than
    // blocking is what keeps `crash` from silently freezing every process
    // that happens to reach an I/O burst before the user runs `fsck`.
    if (filesystem.isCrashed()) return false
    const cylinder = Math.floor(Math.random() * DEFAULT_FS_CONFIG.blockCount)
    return filesystem.requestDeviceIo(cylinder, Math.random() < 0.7 ? 'read' : 'write', pid)
  },
})

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
// Uses the permission-bypassing write/delete, not the normal ones: /swap
// files are deliberately visible for inspection (`ls /swap`, `free`'s
// hint), which means a user can reach them with `chmod`. Enforcing that
// against the memory subsystem's own bookkeeping writes would let a user
// permanently leak a disk block just by chmod'ing a swap file read-only
// (found by code review) — real swap space isn't something userspace
// permissions apply to either.
function swapOut(pid: number, page: number): void {
  if (filesystem.isCrashed()) return
  filesystem.writeIgnoringPermissions(swapPath(pid, page), SWAP_PAGE_CONTENT)
}

function swapIn(pid: number, page: number): void {
  if (filesystem.isCrashed()) return
  filesystem.deleteIgnoringPermissions(swapPath(pid, page))
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
    if (entry.type === 'file') filesystem.deleteIgnoringPermissions(`/swap/${entry.name}`)
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
//
// A thread group (roadmap-v4.md §2.1, spawnThreadGroup() below) complicates
// this: several pids share one memoryOwnerPid's allocation, so the shared
// address space can only be freed once every one of them has terminated —
// freeing it on the first thread to exit would yank memory out from under
// its still-running siblings. For an ordinary process, memoryOwnerPid is
// just its own pid and no other process ever shares it, so this reduces to
// exactly the old immediate-free behavior.
// A process going away closes whichever end of a pipe it held, and
// releases whoever was parked on the other end (roadmap-v5.md §1.2) — a
// reader blocked on an empty pipe whose writer just exited would
// otherwise wait forever for data that can never arrive. This is what
// lets both halves of a pipeline actually terminate.
simBus.on('process:terminated', ({ pid }) => {
  for (const waiter of pipes.closeEndpoint(pid)) scheduler.wake(waiter, 'pipe')
})

simBus.on('process:terminated', ({ memoryOwnerPid }) => {
  // A tempting-looking optimization here would be to skip this scan
  // whenever `memoryOwnerPid === pid`, on the theory that only a thread
  // FOLLOWER ever has `memoryOwnerPid !== own pid`, so anything with
  // `memoryOwnerPid === pid` "can't have a living sibling." That's wrong:
  // a thread group's LEADER also has `memoryOwnerPid === own pid` (it's
  // the group's original member, so it defaults to owning its own
  // allocation — see spawnThreadGroup() below) while its followers are
  // very much still alive and pointing their own memoryOwnerPid at it.
  // Considered and rejected during code review — verified by running
  // engines.test.ts's "order of termination does not matter" case, which
  // fails the moment the leader is killed before its followers if this
  // scan is skipped for it. The scan is cheap relative to that risk: this
  // simulator never has more than a handful of live processes at once.
  const groupStillAlive = scheduler
    .getProcesses()
    .some((p) => p.memoryOwnerPid === memoryOwnerPid && p.state !== 'TERMINATED')
  if (groupStillAlive) return

  // Read the swapped pages *before* freeProcess() drops the page table —
  // it's the only record of which pages still have a page file to clean up.
  for (const page of memory.getSwappedPages(memoryOwnerPid)) swapIn(memoryOwnerPid, page)
  memory.freeProcess(memoryOwnerPid)
})

// Real filesystem persistence (roadmap.md §1.5) — the disk is the one
// engine that survives a reload. Debounced so a burst of mutations (e.g.
// the scripted demo mode typing several commands in quick succession)
// writes to IndexedDB once, not once per keystroke's worth of state.
const FS_SAVE_DEBOUNCE_MS = 400
let fsSaveTimer: ReturnType<typeof setTimeout> | null = null
// Every save currently in flight, not just the latest one. A single
// shared variable isn't enough here: the debounce restarts on every
// mutation, but nothing stops a *second* debounced save from starting
// (and overwriting a single "the in-flight save" slot) while the first
// one is still pending — a slow IndexedDB write plus back-to-back
// mutations makes this a real, if narrow, window. resetFilesystem() and
// the cross-tab handler below both need to wait for ALL of them, or
// whichever one finishes last after they've stopped waiting can still
// silently resurrect stale content (found by code review).
const fsSavesInFlight = new Set<Promise<void>>()

function scheduleFilesystemSave(): void {
  if (fsSaveTimer !== null) clearTimeout(fsSaveTimer)
  fsSaveTimer = setTimeout(() => {
    fsSaveTimer = null
    const save = saveFilesystemState(filesystem.exportState())
      .then(() => announceFilesystemChange())
      .finally(() => {
        fsSavesInFlight.delete(save)
      })
    fsSavesInFlight.add(save)
  }, FS_SAVE_DEBOUNCE_MS)
}

simBus.on('fs:mutated', scheduleFilesystemSave)
simBus.on('fs:crashed', scheduleFilesystemSave)
simBus.on('fs:recovered', scheduleFilesystemSave)

/** Is there a local save pending or in flight right now — i.e. does this tab have its own unsaved/unconfirmed edit? */
function hasPendingLocalSave(): boolean {
  return fsSaveTimer !== null || fsSavesInFlight.size > 0
}

// Cross-tab consistency (roadmap-v3.md §2.5) — see the long comment in
// filesystem/persistence.ts for why this exists. Only absorbs another
// tab's change while THIS tab has no unsaved local edit of its own: an
// earlier version always overwrote the live engine via importState(),
// which meant an actively-edited tab could have its own not-yet-saved
// work silently discarded by a change announced from elsewhere — not
// just a brief window, but for as long as edits kept restarting the
// debounce (found by code review). A tab with local edits pending simply
// doesn't sync until it goes idle; its own next save still wins normally.
// `state === null` means the other tab's change was a reset (see
// resetFilesystem() below, which now also announces) — mirrored locally
// with resetToEmpty() rather than silently keeping stale content.
//
// Deliberately does not attempt to reconcile MemoryEngine's per-tab
// `swapped` bookkeeping against whatever /swap/* files land in the
// imported tree — memory is tab-local by design (plan.md §2.5) and pids
// are independently numbered per tab, so a swap page file's name can't be
// meaningfully cross-referenced across tabs anyway.
onExternalFilesystemChange(() => {
  if (hasPendingLocalSave()) return
  void (async () => {
    const state = await loadFilesystemState()
    if (state) {
      if (filesystem.importState(state)) simBus.emit('fs:external-change', {})
    } else {
      filesystem.resetToEmpty()
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
  const inFlight = [...fsSavesInFlight]
  void (async () => {
    // Let every save already in flight finish first, so the clear below
    // is always the last IndexedDB write — see fsSavesInFlight above.
    await Promise.allSettled(inFlight)
    await clearFilesystemState()
    // Other tabs only find out about a reset by hearing about it — this
    // was missing before (found by code review): without it, another
    // open tab keeps its stale pre-reset state indefinitely, and its next
    // save silently re-persists that stale disk, undoing the reset.
    announceFilesystemChange()
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

/**
 * Lightweight processes (roadmap-v4.md §2.1) — `run --threads=n <name>` in
 * the terminal. `count` Process entries, each with its own independent
 * bursts/queue level/state (its own row in `ps`/the Gantt chart, exactly
 * like a real thread has its own kernel scheduling context), but ONE
 * shared address space: memory.allocateProcess() is called exactly once,
 * sized by a single pageCount generated for the whole group and stamped
 * onto every thread's Process.pageCount, so stepSimulation()'s per-tick
 * random memory access (`Math.random() * running.pageCount`) always lands
 * inside the one page table they all actually share.
 *
 * Follower threads get parentPid = the leader's pid rather than SHELL_PID
 * directly — a deliberate reuse of ProcessTree.tsx's existing
 * parent/child nesting (roadmap.md §2.2) to show the group hierarchy for
 * free, with no new UI plumbing: they render nested under their leader
 * instead of as SHELL_PID's direct siblings.
 */
export function spawnThreadGroup(name: string, count: number, parentPid: number = SHELL_PID): Process[] {
  // The terminal's `run --threads=<n>` already enforces 2-8 (commands.ts),
  // but this is an exported engine function any caller (tests included)
  // can reach directly — count < 1 has no leader to allocate memory
  // against and previously crashed on `threads[0]!` (found by code review).
  if (count < 1) return []
  const kind = randomKind()
  const sharedPageCount = 2 + Math.floor(Math.random() * 5)

  const threads: Process[] = []
  for (let i = 0; i < count; i++) {
    const leader = threads[0]
    const process = createProcess(`${name}:t${i + 1}`, kind, undefined, i === 0 ? parentPid : leader!.pid, {
      memoryOwnerPid: leader?.memoryOwnerPid,
      pageCount: sharedPageCount,
    })
    scheduler.spawn(process)
    threads.push(process)
  }

  memory.allocateProcess(threads[0]!.memoryOwnerPid, sharedPageCount)
  for (const t of threads) simBus.emit('process:spawned', { pid: t.pid, name: t.name, kind: t.kind })
  return threads
}

/**
 * `fork <pid>` — roadmap-v5.md §1.3. A child process with a copy-on-write
 * duplicate of its parent's address space: same page count, every resident
 * page *shared* read-only rather than copied, and the copy deferred until
 * one of the two actually writes. `free` shows unchanged memory usage
 * immediately after this, and only climbs once they diverge — which is the
 * observation the whole mechanism exists to make.
 *
 * The child inherits the parent's *remaining* work, since that is what
 * fork duplicates: execution continues in both. The one adjustment is
 * parity — `bursts` alternates CPU/IO and must start on a CPU burst (see
 * generateBursts()), so a parent caught mid-I/O hands over from the next
 * CPU burst instead of from the I/O one it is currently serving. A parent
 * on its final burst has nothing left to hand over, so the child is given
 * a freshly generated workload rather than an empty one.
 *
 * Returns undefined for anything that has no address space of its own to
 * duplicate: an unknown or dead pid, or a thread (roadmap-v4.md §2.1),
 * whose `memoryOwnerPid` points at its group leader. Forking one thread of
 * a group is a genuinely ambiguous operation on a real system too, and
 * refusing is better than picking an interpretation silently.
 */
export function forkProcess(pid: number): Process | undefined {
  const parent = scheduler.getProcess(pid)
  if (!parent || parent.state === 'TERMINATED') return undefined
  if (parent.memoryOwnerPid !== parent.pid) return undefined

  const start = parent.burstIndex % 2 === 0 ? parent.burstIndex : parent.burstIndex + 1
  const inherited = parent.bursts.slice(start)
  if (start === parent.burstIndex && inherited.length > 0 && parent.burstRemaining > 0) {
    inherited[0] = parent.burstRemaining
  }
  const bursts = inherited.length > 0 ? inherited : generateBursts(parent.kind)

  const child = createProcess(parent.name, parent.kind, bursts, parent.pid, { pageCount: parent.pageCount })
  scheduler.spawn(child)
  // Never allocateProcess() — the child's table is a duplicate of the
  // parent's, not a fresh empty one.
  memory.forkAddressSpace(parent.pid, child.pid)
  simBus.emit('process:spawned', { pid: child.pid, name: child.name, kind: child.kind })
  return child
}

/**
 * `pipe <writer> <reader>` — two real processes connected by a real pipe
 * (roadmap-v5.md §1.2). Both are ordinary scheduler processes with their
 * own bursts, own queue level and own row in `ps`/the Gantt chart; the
 * only thing that distinguishes them is that one end of a bounded buffer
 * belongs to each, and the buffer filling or emptying genuinely blocks
 * them.
 *
 * They're spawned as `interactive`: a process that spends its life handing
 * items to another one *is* I/O-bound, and giving it CPU-bound bursts
 * would mean it holds the CPU for 8-20 ticks between pipe operations,
 * hiding the blocking this command exists to show.
 */
export function spawnPipeline(writerName: string, readerName: string, parentPid: number = SHELL_PID): [Process, Process] {
  const writer = spawnProcess(writerName, 'interactive', parentPid)
  const reader = spawnProcess(readerName, 'interactive', writer.pid)
  pipes.create(writer.pid, reader.pid)
  return [writer, reader]
}

const AUTO_SPAWN_INTERVAL = 23
const AUTO_SPAWN_CAP = 7

/** Advance the whole simulation by one tick and return what the scheduler ran. */
export function stepSimulation() {
  const result = scheduler.tick()

  // Advance the disk, then release whoever it just finished serving. Order
  // matters: the request a process submitted during scheduler.tick() above
  // is already queued, so a head that happens to land on it this very tick
  // wakes it immediately rather than a tick late.
  for (const completed of filesystem.advanceTick()) {
    if (completed.waiterPid !== undefined) scheduler.wake(completed.waiterPid, 'device')
  }
  // A `reset-fs` (or a cross-tab import) throws the pending queue away.
  // Anything that was blocked on a discarded request would otherwise wait
  // forever for a completion that no longer exists, so it's released here
  // instead — the I/O failed, but the process still runs.
  for (const pid of filesystem.drainAbandonedIoWaiters()) scheduler.wake(pid, 'device')

  sync.tick()
  network.tick()

  // Whoever is running this tick touches one page of its own address
  // space — this is what actually drives page faults / Clock evictions
  // over time. Accessed by memoryOwnerPid, not pid: for an ordinary
  // process those are the same value, but a thread (roadmap-v4.md §2.1)
  // must access its *group's* shared page table, not one keyed by its own
  // pid (which memory/engine.ts never allocated anything under).
  const running = scheduler.getRunning()
  if (running) {
    const page = Math.floor(Math.random() * running.pageCount)
    const isWrite = Math.random() < 0.3 // most memory references are reads
    const access = memory.access(running.memoryOwnerPid, page, isWrite)
    // Outside the fault branch on purpose: a copy-on-write copy
    // (roadmap-v5.md §1.3) reports `fault: false` — nothing was paged in
    // — but still needs a frame for the private copy, and evicting one to
    // get it produces victims that must reach swap like any other.
    for (const victim of access.victims) swapOut(victim.pid, victim.page)
    if (access.fault) {
      simBus.emit('memory:page-fault', { pid: running.memoryOwnerPid, page, victimFrame: access.victimFrame })
      if (access.wasSwapped) swapIn(running.memoryOwnerPid, page)
    }

    // ...and, if it holds one end of a pipe, drives that end too
    // (roadmap-v5.md §1.2). Deliberately after the memory access above:
    // this process really did run a CPU tick, so its page reference
    // belongs to this tick whether or not the pipe operation then blocks
    // it. Doing it the other way round would silently drop that reference
    // every time an endpoint blocks — and a pipe pair blocks constantly,
    // which would quietly skew the page-fault and TLB statistics.
    //
    // A process only touches a pipe while it is actually on the CPU,
    // which is exactly why a blocked endpoint can't retry by itself and
    // has to be woken by the other side.
    const outcome = pipes.stepEndpoint(running.pid)
    if (outcome.kind === 'block') scheduler.blockOn(running.pid, 'pipe')
    else if (outcome.kind === 'transferred') scheduler.wake(outcome.wakeCounterpart, 'pipe')
    // 'eof' and 'broken' deliberately do nothing to the process itself:
    // the stream is over, so it runs out its remaining CPU bursts and
    // exits normally rather than being killed off by the IPC layer.
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
