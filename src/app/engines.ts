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
import { FdTable } from '../kernel/fdTable'
import { simBus } from '../shared/eventBus'

// Engines never import each other; anything spanning two of them is
// coordinated here.
export const scheduler = new SchedulerEngine()
export const memory = new MemoryEngine()
export const filesystem = new FilesystemEngine()
export const network = new NetworkEngine()
export const deadlock = new DeadlockEngine()
export const banker = new BankerEngine()
export const pipes = new PipeEngine()
export const fdTable = new FdTable()

export let sync = new SyncEngine(false)

export function resetSync(unsafe: boolean): void {
  sync = new SyncEngine(unsafe)
}

memory.reserveKernelFrames(2)

// The cylinder is uniform because the synthetic workload owns no files.
scheduler.setIoPort({
  submit(pid) {
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

const SWAP_PAGE_CONTENT = 'x'.repeat(60)

function swapPath(pid: number, page: number): string {
  return `/swap/${pid}-${page}.swp`
}

// Bypasses the permission check: chmod'ing a swap file read-only must not
// let a user block its own cleanup and leak the block.
function swapOut(pid: number, page: number): void {
  if (filesystem.isCrashed()) return
  filesystem.writeIgnoringPermissions(swapPath(pid, page), SWAP_PAGE_CONTENT)
}

function swapIn(pid: number, page: number): void {
  if (filesystem.isCrashed()) return
  filesystem.deleteIgnoringPermissions(swapPath(pid, page))
}

/** Memory doesn't survive a reload but the disk does, so hydrated /swap files are orphans. */
function clearSwapFiles(): void {
  const result = filesystem.list('/swap')
  if (!result.ok) return
  for (const entry of result.entries) {
    if (entry.type === 'file') filesystem.deleteIgnoringPermissions(`/swap/${entry.name}`)
  }
}

simBus.on('process:terminated', ({ pid }) => {
  for (const waiter of pipes.closeEndpoint(pid)) scheduler.wake(waiter, 'pipe')
  fdTable.closeAll(pid)
})

// A thread group shares one allocation, so it survives until every member exits.
simBus.on('process:terminated', ({ memoryOwnerPid }) => {
  const groupStillAlive = scheduler
    .getProcesses()
    .some((p) => p.memoryOwnerPid === memoryOwnerPid && p.state !== 'TERMINATED')
  if (groupStillAlive) return

  for (const page of memory.getSwappedPages(memoryOwnerPid)) swapIn(memoryOwnerPid, page)
  memory.freeProcess(memoryOwnerPid)
})

const FS_SAVE_DEBOUNCE_MS = 400
let fsSaveTimer: ReturnType<typeof setTimeout> | null = null
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

function hasPendingLocalSave(): boolean {
  return fsSaveTimer !== null || fsSavesInFlight.size > 0
}

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

export function resetFilesystem(): void {
  filesystem.resetToEmpty()
  if (fsSaveTimer !== null) {
    clearTimeout(fsSaveTimer)
    fsSaveTimer = null
  }
  const inFlight = [...fsSavesInFlight]
  void (async () => {
    await Promise.allSettled(inFlight)
    await clearFilesystemState()
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

export function stopProcess(pid: number): boolean {
  return scheduler.stop(pid) !== undefined
}

export function continueProcess(pid: number): boolean {
  return scheduler.cont(pid) !== undefined
}

export function spawnStressLoad(count: number): Process[] {
  return Array.from({ length: count }, () => spawnProcess(randomName(), 'cpu-bound', SHELL_PID))
}

/** One Process per thread, but allocateProcess runs once for the whole group. */
export function spawnThreadGroup(name: string, count: number, parentPid: number = SHELL_PID): Process[] {
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
 * The child inherits the parent's remaining bursts, offset by one when the
 * parent is mid-I/O so it still starts on a CPU burst.
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
  memory.forkAddressSpace(parent.pid, child.pid)
  simBus.emit('process:spawned', { pid: child.pid, name: child.name, kind: child.kind })
  return child
}

/** Interactive, not CPU-bound: long bursts between pipe operations would hide the blocking. */
export function spawnPipeline(writerName: string, readerName: string, parentPid: number = SHELL_PID): [Process, Process] {
  const writer = spawnProcess(writerName, 'interactive', parentPid)
  const reader = spawnProcess(readerName, 'interactive', writer.pid)
  const pipe = pipes.create(writer.pid, reader.pid)
  fdTable.open(writer.pid, 'pipe-write', `pipe:[${pipe.id}]`)
  fdTable.open(reader.pid, 'pipe-read', `pipe:[${pipe.id}]`)
  return [writer, reader]
}

const AUTO_SPAWN_INTERVAL = 23
const AUTO_SPAWN_CAP = 7

export function stepSimulation() {
  const result = scheduler.tick()

  for (const completed of filesystem.advanceTick()) {
    if (completed.waiterPid !== undefined) scheduler.wake(completed.waiterPid, 'device')
  }
  for (const pid of filesystem.drainAbandonedIoWaiters()) scheduler.wake(pid, 'device')

  sync.tick()
  network.tick()

  for (const running of scheduler.getRunningProcesses()) {
    if (!running) continue
    const page = Math.floor(Math.random() * running.pageCount)
    const isWrite = Math.random() < 0.3
    const access = memory.access(running.memoryOwnerPid, page, isWrite)
    for (const victim of access.victims) swapOut(victim.pid, victim.page)
    if (access.fault) {
      simBus.emit('memory:page-fault', { pid: running.memoryOwnerPid, page, victimFrame: access.victimFrame })
      if (access.wasSwapped) swapIn(running.memoryOwnerPid, page)
    }

    const outcome = pipes.stepEndpoint(running.pid)
    if (outcome.kind === 'block') scheduler.blockOn(running.pid, 'pipe')
    else if (outcome.kind === 'transferred') scheduler.wake(outcome.wakeCounterpart, 'pipe')
  }

  const active = scheduler.getProcesses().filter((p) => p.state !== 'TERMINATED').length
  if (active < AUTO_SPAWN_CAP && result.tick % AUTO_SPAWN_INTERVAL === 0) {
    spawnProcess(randomName())
  }

  return result
}

export function bootstrapWorkload(fromDisk = false): void {
  spawnProcess(randomName(), 'interactive')
  spawnProcess(randomName(), 'cpu-bound')
  spawnProcess(randomName(), 'interactive')
  filesystem.write(
    '/var/log/boot.log',
    fromDisk ? 'system rebooted — disk restored from previous session\n' : 'system initialised\n',
  )
}

export async function hydrateAndBootstrap(): Promise<void> {
  const state = await loadFilesystemState()
  const fromDisk = state !== null && filesystem.importState(state)
  if (fromDisk) clearSwapFiles()
  bootstrapWorkload(fromDisk)
}
