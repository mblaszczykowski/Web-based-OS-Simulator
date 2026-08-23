export type ProcessState = 'NEW' | 'READY' | 'RUNNING' | 'WAITING' | 'STOPPED' | 'TERMINATED'

export type BlockReason = 'io-burst' | 'device' | 'pipe'

export type ProcessKind = 'cpu-bound' | 'interactive'

export type QueueLevel = 0 | 1 | 2

export const SHELL_PID = -1
export const INIT_PID = -2

export interface Process {
  pid: number
  name: string
  kind: ProcessKind
  state: ProcessState
  queueLevel: QueueLevel
  parentPid: number
  memoryOwnerPid: number

  arrivalTick: number
  finishTick: number | null

  bursts: number[]
  burstIndex: number
  burstRemaining: number

  sliceRemaining: number

  core: number | null

  blockedOn: BlockReason | null

  totalWaitingTicks: number
  totalBurstTicks: number
  contextSwitches: number

  pageCount: number
}

export interface GanttSample {
  tick: number
  pids: (number | null)[]
}

export interface PageTableEntry {
  page: number
  frame: number | null
  valid: boolean
  referenced: boolean
  modified: boolean
  swapped: boolean
  cow: boolean
}

export interface Frame {
  index: number
  owner: { pid: number; page: number } | null
  shares: { pid: number; page: number }[]
}

export interface ContiguousBlock {
  id: string
  start: number
  size: number
  owner: number | null
}

export type DirNodeType = 'file' | 'dir' | 'symlink'

export interface DirEntry {
  name: string
  type: DirNodeType
  inode?: number
  children?: DirEntry[]
  target?: string
}

export interface Inode {
  id: number
  size: number
  blockIds: number[]
  links: number
  mode: number
}

export interface DiskBlock {
  index: number
  owner: number | null
}

export type JournalOp = 'create' | 'write' | 'delete' | 'mkdir' | 'move' | 'copy' | 'link' | 'symlink' | 'chmod'

export interface JournalEntry {
  id: number
  op: JournalOp
  path: string
  content?: string
  target?: string
  status: 'pending' | 'committed'
  tick: number
}

export type SyncRole = 'producer' | 'consumer'

export type SyncActorState = 'idle' | 'waiting-empty' | 'waiting-full' | 'waiting-mutex' | 'in-critical-section'

export interface SyncActor {
  id: number
  role: SyncRole
  state: SyncActorState
  itemsHandled: number
  capturedSlot: number | null
}

export interface SyncLogEntry {
  id: number
  text: string
  kind: 'info' | 'block' | 'warning'
}

export interface PipeState {
  id: number
  writerPid: number
  readerPid: number
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

export interface TerminalLine {
  id: number
  kind: 'prompt' | 'output' | 'error'
  text: string
  cwd?: string
}
