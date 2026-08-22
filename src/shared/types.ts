// Core domain types shared across every module. This is the contract the
// scheduler, memory, filesystem and terminal engines are all written against.

/** STOPPED is a SIGSTOP pause (roadmap-v3.md §2.2) — distinct from TERMINATED. tick() skips a stopped process entirely (no burst consumed, no waiting accrued) until a SIGCONT returns it to READY. */
export type ProcessState = 'NEW' | 'READY' | 'RUNNING' | 'WAITING' | 'STOPPED' | 'TERMINATED'

/**
 * Why a WAITING process is waiting — roadmap-v5.md §1.1. Before this
 * existed there was exactly one kind of wait (a self-timed I/O burst) and
 * the scheduler could infer everything about it from `burstIndex`'s parity.
 * Now a wait can also be owned by something outside the scheduler, which
 * has to be recorded rather than inferred:
 *
 *  - `io-burst`: the original model — a countdown of `burstRemaining` ticks
 *    resolved by the scheduler itself. Still the fallback whenever no
 *    device port is installed (pure unit tests) or the device refuses the
 *    request (e.g. a crashed filesystem).
 *  - `device`: a real request submitted to the disk (SCAN, see
 *    filesystem/ioScheduler.ts). The scheduler does NOT count this down —
 *    the process stays blocked until the disk head actually services its
 *    request and something calls `wake()`.
 *  - `pipe`: blocked on a kernel pipe (roadmap-v5.md §1.2) — a full pipe
 *    for a writer, an empty one for a reader. Also externally woken.
 *
 * `io-burst` is the only reason the scheduler resolves on its own; every
 * other reason means "someone else owns this wakeup".
 */
export type BlockReason = 'io-burst' | 'device' | 'pipe'

export type ProcessKind = 'cpu-bound' | 'interactive'

/** MLFQ priority levels. 0 is the highest priority (shortest quantum). */
export type QueueLevel = 0 | 1 | 2

/** Pseudo-pids for the two synthetic "processes" every real one is spawned under — see roadmap.md §2.2. */
export const SHELL_PID = -1
export const INIT_PID = -2

export interface Process {
  pid: number
  name: string
  kind: ProcessKind
  state: ProcessState
  queueLevel: QueueLevel
  /** SHELL_PID for anything spawned via the terminal's `run`, INIT_PID for the automatic workload, or another process's pid. */
  parentPid: number
  /**
   * Which pid's address space (memory/engine.ts allocation) this one
   * actually uses. Equal to its own pid for every ordinary process — a
   * process owns its own memory. A thread (roadmap-v4.md §2.1,
   * `run --threads=n`) instead points at its thread group's leader pid:
   * several Process entries, each with its own scheduler/Gantt presence
   * (own bursts, own queue level, own state), sharing one allocation. See
   * app/engines.ts's spawnThreadGroup() and its `process:terminated`
   * subscriber, which only frees memory once every pid sharing a given
   * memoryOwnerPid has terminated.
   */
  memoryOwnerPid: number

  /** Tick the process became READY for the first time. */
  arrivalTick: number
  /** Tick the process left RUNNING for the last time (TERMINATED). */
  finishTick: number | null

  /**
   * A process's total CPU need is modelled as an alternating sequence of
   * CPU bursts and I/O bursts, starting and ending with a CPU burst — the
   * classic Silberschatz burst-cycle model. `burstIndex` points at the
   * burst currently being served; `burstRemaining` is how many ticks are
   * left in it.
   */
  bursts: number[]
  burstIndex: number
  burstRemaining: number

  /** How many ticks left in the current MLFQ time slice, once running. */
  sliceRemaining: number

  /**
   * Why this process is blocked, or null when it isn't — roadmap-v5.md
   * §1.1. Meaningful whenever state is WAITING, and deliberately preserved
   * across a SIGSTOP so `cont()` can put a still-blocked process back into
   * WAITING instead of guessing from burst parity (see BlockReason).
   */
  blockedOn: BlockReason | null

  /** Bookkeeping used to compute waiting time / turnaround time. */
  totalWaitingTicks: number
  totalBurstTicks: number
  contextSwitches: number

  /** Pages this process's address space is made of (memory module). */
  pageCount: number
}

export interface GanttSample {
  tick: number
  pid: number | null
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export interface PageTableEntry {
  page: number
  frame: number | null
  valid: boolean
  referenced: boolean
  modified: boolean
  /** Evicted and currently backed by a page file on disk (roadmap.md §2.1) rather than just discarded. */
  swapped: boolean
}

export interface Frame {
  index: number
  /** null = free frame. */
  owner: { pid: number; page: number } | null
}

export interface ContiguousBlock {
  id: string
  /** Start offset and size, both in simulated MB. */
  start: number
  size: number
  owner: number | null // pid, or null when free
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export type DirNodeType = 'file' | 'dir'

export interface DirEntry {
  name: string
  type: DirNodeType
  /** Only present for files. */
  inode?: number
  /** Only present for directories. */
  children?: DirEntry[]
}

export interface Inode {
  id: number
  size: number
  blockIds: number[]
  links: number
  /** rwx permission bits for this single-user simulator's one "owner" — roadmap-v3.md §2.3. See filesystem/engine.ts's MODE_* constants. */
  mode: number
}

export interface DiskBlock {
  index: number
  /** inode id that owns this block, or null when free. */
  owner: number | null
}

export type JournalOp = 'create' | 'write' | 'delete' | 'mkdir' | 'move' | 'copy' | 'link' | 'chmod'

export interface JournalEntry {
  id: number
  op: JournalOp
  path: string
  /** Content payload for create/write/copy (copy's is a snapshot of the source, taken at request time), unused otherwise. */
  content?: string
  /** Destination path for move/copy; unused otherwise. */
  target?: string
  status: 'pending' | 'committed'
  tick: number
}

// ---------------------------------------------------------------------------
// Process synchronization (bounded-buffer producer/consumer)
// ---------------------------------------------------------------------------

export type SyncRole = 'producer' | 'consumer'

/**
 * idle -> waiting-{empty,full} (blocked on the counting semaphore) ->
 * waiting-mutex (has its slot reserved, blocked entering the critical
 * section) -> in-critical-section (captured its buffer slot, about to
 * commit) -> back to idle. See sync/engine.ts for the full state machine.
 */
export type SyncActorState = 'idle' | 'waiting-empty' | 'waiting-full' | 'waiting-mutex' | 'in-critical-section'

export interface SyncActor {
  id: number
  role: SyncRole
  state: SyncActorState
  itemsHandled: number
  /** Buffer slot this actor captured on entering the critical section, or null. */
  capturedSlot: number | null
}

export interface SyncLogEntry {
  id: number
  text: string
  kind: 'info' | 'block' | 'warning'
}

// ---------------------------------------------------------------------------
// IPC (anonymous pipes)
// ---------------------------------------------------------------------------

/**
 * One anonymous pipe connecting two real processes — roadmap-v5.md §1.2.
 * `writerOpen`/`readerOpen` go false when that end's process terminates:
 * a closed writer is EOF for the reader, a closed reader breaks the pipe
 * for the writer.
 */
export interface PipeState {
  id: number
  writerPid: number
  readerPid: number
  /** Item sequence numbers currently buffered, oldest first. */
  buffer: number[]
  capacity: number
  writtenTotal: number
  readTotal: number
  writerOpen: boolean
  readerOpen: boolean
}

export interface PipeLogEntry {
  id: number
  pipeId: number
  text: string
  kind: 'info' | 'block' | 'warning'
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

export interface TerminalLine {
  id: number
  kind: 'prompt' | 'output' | 'error'
  text: string
  /** Working directory the command was typed in, kind:'prompt' only — see roadmap-v3.md §1.1. Historical lines keep the cwd they were actually run in, not the terminal's current one. */
  cwd?: string
}
