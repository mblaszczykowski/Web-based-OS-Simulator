import type { DirEntry, DiskBlock, Inode, JournalEntry, JournalOp } from '../shared/types'
import { simBus } from '../shared/eventBus'
import { IoScheduler, type CompletedIoRequest, type IoSchedulerMetrics, type IoSchedulerState } from './ioScheduler'
import { FreeSpaceBitmap } from './freeSpaceBitmap'

export interface FilesystemConfig {
  blockCount: number
  blockSizeBytes: number
  journalHistoryLimit: number
  seekCylindersPerTick?: number
}

export const DEFAULT_FS_CONFIG: FilesystemConfig = {
  blockCount: 64,
  blockSizeBytes: 64,
  journalHistoryLimit: 50,
  seekCylindersPerTick: 4,
}

export type FsResult = { ok: true } | { ok: false; error: string }
export type FsReadResult = { ok: true; content: string } | { ok: false; error: string }

interface InternalInode extends Inode {
  content: string
}

export const MODE_READ = 0b100
export const MODE_WRITE = 0b010
export const MODE_EXEC = 0b001
export const DEFAULT_FILE_MODE = MODE_READ | MODE_WRITE

export function rwxTriplet(mode: number): string {
  return `${mode & MODE_READ ? 'r' : '-'}${mode & MODE_WRITE ? 'w' : '-'}${mode & MODE_EXEC ? 'x' : '-'}`
}

export const FS_SCHEMA_VERSION = 2

export interface FilesystemState {
  schemaVersion: number
  blockCount: number
  blocks: DiskBlock[]
  inodes: InternalInode[]
  root: DirEntry
  journal: JournalEntry[]
  nextInodeId: number
  nextJournalId: number
  tick: number
  crashed: boolean
  lastTouchedPath: string | null
}

/**
 * Inode-based filesystem over a simulated block device, with a write-ahead
 * log so a crash mid-write can be replayed to a consistent state on the
 * next fsck. Aims to demonstrate the idea — log before write, replay what
 * is pending — not to match a production journaling filesystem.
 */
export class FilesystemEngine {
  private blocks: DiskBlock[]
  private inodes = new Map<number, InternalInode>()
  private root: DirEntry = { name: '/', type: 'dir', children: [] }
  private journal: JournalEntry[] = []
  private nextInodeId = 1
  private nextJournalId = 1
  private tick = 0
  private crashed = false
  private lastTouchedPath: string | null = null
  private ioScheduler: IoScheduler
  private abandonedIoWaiters: number[] = []
  private freeSpace: FreeSpaceBitmap

  constructor(private config: FilesystemConfig = DEFAULT_FS_CONFIG) {
    this.blocks = Array.from({ length: config.blockCount }, (_, index) => ({ index, owner: null }))
    this.ioScheduler = new IoScheduler(config.blockCount, config.seekCylindersPerTick ?? 1)
    this.freeSpace = new FreeSpaceBitmap(config.blockCount)
  }

  // The only two places a block changes hands. Both representations — the
  // bitmap that decides availability and the owner the grid renders — move
  // together here, so they cannot drift apart.
  private claimBlock(blockIndex: number, inodeId: number): void {
    this.freeSpace.claim(blockIndex)
    const block = this.blocks[blockIndex]
    if (block) block.owner = inodeId
  }

  private releaseBlock(blockIndex: number): void {
    this.freeSpace.release(blockIndex)
    const block = this.blocks[blockIndex]
    if (block) block.owner = null
  }

  advanceTick(): CompletedIoRequest[] {
    this.tick++
    return this.ioScheduler.step(this.tick)
  }

  requestDeviceIo(blockIndex: number, kind: 'read' | 'write', waiterPid: number): boolean {
    return this.ioScheduler.enqueue(blockIndex, kind, this.tick, waiterPid)
  }

  drainAbandonedIoWaiters(): number[] {
    const abandoned = this.abandonedIoWaiters
    this.abandonedIoWaiters = []
    return abandoned
  }

  isCrashed(): boolean {
    return this.crashed
  }

  create(path: string): FsResult {
    return this.mutate('create', path, '')
  }

  write(path: string, text: string): FsResult {
    return this.mutate('write', path, text)
  }

  delete(path: string): FsResult {
    return this.mutate('delete', path)
  }

  writeIgnoringPermissions(path: string, text: string): FsResult {
    return this.mutate('write', path, text, { skipPermissionCheck: true })
  }

  deleteIgnoringPermissions(path: string): FsResult {
    return this.mutate('delete', path, undefined, { skipPermissionCheck: true })
  }

  mkdir(path: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const resolved = this.resolveLinks(path, false)
    if (!resolved.ok) return { ok: false, error: `mkdir: ${resolved.error}` }
    if (this.findFileEntry(resolved.path) || this.findDirEntry(resolved.path) || this.findSymlinkEntry(resolved.path)) {
      return { ok: false, error: `mkdir: ${path}: File exists` }
    }
    if (this.ancestorIsFile(resolved.path)) return { ok: false, error: `mkdir: ${path}: Not a directory` }

    this.commitJournalEntry('mkdir', { path: resolved.path, touchedPath: resolved.path })
    return { ok: true }
  }

  move(srcPath: string, destPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const src = this.resolveLinks(srcPath, false)
    if (!src.ok) return { ok: false, error: `mv: ${src.error}` }
    const dest = this.resolveLinks(destPath, false)
    if (!dest.ok) return { ok: false, error: `mv: ${dest.error}` }
    if (this.findDirEntry(src.path)) return { ok: false, error: `mv: ${srcPath}: Is a directory` }
    if (!this.findFileEntry(src.path) && !this.findSymlinkEntry(src.path)) {
      return { ok: false, error: `mv: ${srcPath}: No such file or directory` }
    }
    if (this.findFileEntry(dest.path) || this.findDirEntry(dest.path) || this.findSymlinkEntry(dest.path)) {
      return { ok: false, error: `mv: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(dest.path)) return { ok: false, error: `mv: ${destPath}: Not a directory` }

    this.commitJournalEntry('move', { path: src.path, target: dest.path, touchedPath: dest.path })
    return { ok: true }
  }

  link(srcPath: string, destPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const src = this.resolveLinks(srcPath, true)
    if (!src.ok) return { ok: false, error: `ln: ${src.error}` }
    const dest = this.resolveLinks(destPath, false)
    if (!dest.ok) return { ok: false, error: `ln: ${dest.error}` }
    if (this.findDirEntry(src.path)) return { ok: false, error: `ln: ${srcPath}: hard link not allowed for directory` }
    if (!this.findFileEntry(src.path)) return { ok: false, error: `ln: ${srcPath}: No such file or directory` }
    if (this.findFileEntry(dest.path) || this.findDirEntry(dest.path) || this.findSymlinkEntry(dest.path)) {
      return { ok: false, error: `ln: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(dest.path)) return { ok: false, error: `ln: ${destPath}: Not a directory` }

    this.commitJournalEntry('link', { path: src.path, target: dest.path, touchedPath: dest.path })
    return { ok: true }
  }

  /**
   * Unlike a hard link, the target is neither resolved nor required to
   * exist: a symlink stores a name, and a dangling one starts working the
   * moment its target appears.
   */
  symlink(targetPath: string, linkPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const link = this.resolveLinks(linkPath, false)
    if (!link.ok) return { ok: false, error: `ln: ${link.error}` }
    if (this.findFileEntry(link.path) || this.findDirEntry(link.path) || this.findSymlinkEntry(link.path)) {
      return { ok: false, error: `ln: ${linkPath}: already exists` }
    }
    if (this.ancestorIsFile(link.path)) return { ok: false, error: `ln: ${linkPath}: Not a directory` }

    this.commitJournalEntry('symlink', { path: link.path, target: targetPath, touchedPath: link.path })
    return { ok: true }
  }

  chmod(path: string, mode: number): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const resolved = this.resolveLinks(path, true)
    if (!resolved.ok) return { ok: false, error: `chmod: ${resolved.error}` }
    if (this.findDirEntry(resolved.path)) return { ok: false, error: `chmod: ${path}: Is a directory` }
    if (!this.findFileEntry(resolved.path)) return { ok: false, error: `chmod: ${path}: No such file or directory` }

    this.commitJournalEntry('chmod', { path: resolved.path, content: String(mode), touchedPath: resolved.path })
    return { ok: true }
  }

  copy(srcPath: string, destPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const src = this.resolveLinks(srcPath, true)
    if (!src.ok) return { ok: false, error: `cp: ${src.error}` }
    const dest = this.resolveLinks(destPath, false)
    if (!dest.ok) return { ok: false, error: `cp: ${dest.error}` }
    srcPath = src.path
    destPath = dest.path
    if (this.findDirEntry(srcPath)) return { ok: false, error: `cp: ${srcPath}: Is a directory` }
    const srcEntry = this.findFileEntry(srcPath)
    if (!srcEntry) return { ok: false, error: `cp: ${srcPath}: No such file or directory` }
    const srcInode = this.inodes.get(srcEntry.inode!)!
    if (!(srcInode.mode & MODE_READ)) return { ok: false, error: `cp: ${srcPath}: Permission denied` }
    if (this.findFileEntry(destPath) || this.findDirEntry(destPath) || this.findSymlinkEntry(destPath)) {
      return { ok: false, error: `cp: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(destPath)) return { ok: false, error: `cp: ${destPath}: Not a directory` }

    const content = srcInode.content
    const neededBlocks = content.length === 0 ? 0 : Math.ceil(content.length / this.config.blockSizeBytes)
    if (neededBlocks > this.freeSpace.freeCount) return { ok: false, error: `cp: ${destPath}: No space left on device` }

    this.commitJournalEntry('copy', { path: destPath, content, target: srcPath, touchedPath: destPath })
    return { ok: true }
  }

  list(
    path = '/',
  ):
    | { ok: true; entries: { name: string; type: DirEntry['type']; mode?: number; size?: number; target?: string }[] }
    | { ok: false; error: string } {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const resolved = this.resolveLinks(path, true)
    if (!resolved.ok) return { ok: false, error: `ls: ${resolved.error}` }
    let dir: DirEntry
    try {
      dir = this.resolveDir(this.splitPath(resolved.path), false)
    } catch {
      return { ok: false, error: `ls: ${path}: No such file or directory` }
    }
    const entries = (dir.children ?? []).map((c) => {
      if (c.type === 'file') {
        const inode = this.inodes.get(c.inode!)
        return { name: c.name, type: c.type, mode: inode?.mode, size: inode?.size }
      }
      if (c.type === 'symlink') return { name: c.name, type: c.type, target: c.target }
      return { name: c.name, type: c.type }
    })
    return { ok: true, entries }
  }

  read(path: string): FsReadResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const resolved = this.resolveLinks(path, true)
    if (!resolved.ok) return { ok: false, error: `cat: ${resolved.error}` }
    path = resolved.path
    const entry = this.findFileEntry(path)
    if (!entry) return { ok: false, error: `cat: ${path}: No such file or directory` }
    const inode = this.inodes.get(entry.inode!)!
    if (!(inode.mode & MODE_READ)) return { ok: false, error: `cat: ${path}: Permission denied` }
    if (inode.blockIds.length > 0) this.ioScheduler.enqueue(inode.blockIds[0]!, 'read', this.tick)
    return { ok: true, content: inode.content }
  }

  /** Simulated power loss: log an entry describing a write, then never apply it. */
  crash(): void {
    if (this.crashed) return
    const path = this.lastTouchedPath ?? '/crash-test.tmp'
    this.journal.push({
      id: this.nextJournalId++,
      op: 'write',
      path,
      content: ' [uncommitted]',
      status: 'pending',
      tick: this.tick,
    })
    this.trimJournal()
    this.crashed = true
    simBus.emit('fs:crashed', {})
  }

  /** Replay every pending journal entry, as a real mount would. */
  fsck(): { replayed: JournalEntry[] } {
    const pending = this.journal.filter((entry) => entry.status === 'pending')
    for (const entry of pending) {
      this.apply(entry.op, entry.path, entry.content ?? '', entry.target)
      entry.status = 'committed'
    }
    this.crashed = false
    simBus.emit('fs:recovered', { replayed: pending.length })
    return { replayed: pending }
  }

  private mutate(op: JournalOp, path: string, content?: string, opts: { skipPermissionCheck?: boolean } = {}): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError

    const resolved = this.resolveLinks(path, op !== 'delete')
    if (!resolved.ok) return { ok: false, error: `${op}: ${resolved.error}` }
    path = resolved.path

    if (op === 'delete' && this.findSymlinkEntry(path)) {
      this.commitJournalEntry('delete', { path, touchedPath: null })
      return { ok: true }
    }

    if ((op === 'create' || op === 'write') && this.findDirEntry(path)) {
      return { ok: false, error: `${op}: ${path}: Is a directory` }
    }
    if ((op === 'create' || op === 'write') && this.ancestorIsFile(path)) {
      return { ok: false, error: `${op}: ${path}: Not a directory` }
    }
    if (op === 'delete') {
      if (this.findDirEntry(path) || this.findSymlinkEntry(path)) return { ok: false, error: `rm: ${path}: Is a directory` }
      if (!this.findFileEntry(path)) return { ok: false, error: `rm: ${path}: No such file or directory` }
    }
    if (op === 'create' && this.findFileEntry(path)) {
      return { ok: false, error: `create: ${path}: already exists` }
    }
    if ((op === 'write' || op === 'delete') && !opts.skipPermissionCheck) {
      const existing = this.findFileEntry(path)
      if (existing) {
        const inode = this.inodes.get(existing.inode!)!
        if (!(inode.mode & MODE_WRITE)) return { ok: false, error: `${op === 'write' ? 'write' : 'rm'}: ${path}: Permission denied` }
      }
    }
    if (op === 'write' && this.growthExceedsFreeSpace(path, content ?? '')) {
      return { ok: false, error: `write: ${path}: No space left on device` }
    }

    this.commitJournalEntry(op, {
      path,
      content,
      touchedPath: op === 'delete' ? null : path,
      skipPermissionCheck: opts.skipPermissionCheck,
    })
    return { ok: true }
  }

  private rejectIfCrashed(): { ok: false; error: string } | null {
    return this.crashed ? { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' } : null
  }

  /** Shared tail for every mutation: log it pending, apply it, mark it committed, announce it. */
  private commitJournalEntry(
    op: JournalOp,
    opts: { path: string; content?: string; target?: string; touchedPath: string | null; skipPermissionCheck?: boolean },
  ): void {
    const entry: JournalEntry = {
      id: this.nextJournalId++,
      op,
      path: opts.path,
      content: opts.content,
      target: opts.target,
      status: 'pending',
      tick: this.tick,
    }
    this.journal.push(entry)
    this.trimJournal()

    this.apply(op, opts.path, opts.content ?? '', opts.target, opts.skipPermissionCheck)
    entry.status = 'committed'
    if (opts.touchedPath !== null) this.lastTouchedPath = opts.touchedPath
    simBus.emit('fs:mutated', { op, path: opts.touchedPath ?? opts.path })
  }

  private apply(op: JournalOp, path: string, content: string, target?: string, skipPermissionCheck = false): void {
    switch (op) {
      case 'create':
        return this.applyCreate(path)
      case 'write':
        return this.applyWrite(path, content, skipPermissionCheck)
      case 'delete':
        return this.applyDelete(path, skipPermissionCheck)
      case 'mkdir':
        return this.applyMkdir(path)
      case 'move':
        return this.applyMove(path, target!)
      case 'copy':
        return this.applyCopy(path, content)
      case 'link':
        return this.applyLink(path, target!)
      case 'symlink':
        return this.applySymlink(path, target!)
      case 'chmod':
        return this.applyChmod(path, content)
      default: {
        const exhaustive: never = op
        void exhaustive
      }
    }
  }

  private applyMkdir(path: string): void {
    if (this.findDirEntry(path) || this.findFileEntry(path)) return
    const segments = this.splitPath(path)
    const name = segments.pop()
    if (!name) return
    const dir = this.resolveDir(segments, true)
    dir.children!.push({ name, type: 'dir', children: [] })
  }

  private applyMove(srcPath: string, destPath: string): void {
    const fileEntry = this.findFileEntry(srcPath) ?? this.findSymlinkEntry(srcPath)
    if (!fileEntry) return
    const srcSegments = this.splitPath(srcPath)
    srcSegments.pop()
    const srcDir = this.resolveDir(srcSegments, false)
    srcDir.children = (srcDir.children ?? []).filter((c) => c !== fileEntry)

    const destSegments = this.splitPath(destPath)
    const destName = destSegments.pop()!
    const destDir = this.resolveDir(destSegments, true)
    destDir.children!.push({ ...fileEntry, name: destName })
  }

  private applyLink(srcPath: string, destPath: string): void {
    const srcEntry = this.findFileEntry(srcPath)
    if (!srcEntry) return
    const inode = this.inodes.get(srcEntry.inode!)
    if (!inode) return
    const segments = this.splitPath(destPath)
    const name = segments.pop()
    if (!name) return
    const dir = this.resolveDir(segments, true)
    dir.children!.push({ name, type: 'file', inode: inode.id })
    inode.links++
  }

  private applySymlink(path: string, target: string): void {
    if (this.findFileEntry(path) || this.findDirEntry(path) || this.findSymlinkEntry(path)) return
    const segments = this.splitPath(path)
    const name = segments.pop()
    if (!name) return
    const dir = this.resolveDir(segments, true)
    dir.children!.push({ name, type: 'symlink', target })
  }

  private applyChmod(path: string, modeStr: string): void {
    const fileEntry = this.findFileEntry(path)
    if (!fileEntry) return
    const inode = this.inodes.get(fileEntry.inode!)
    if (!inode) return
    const mode = Number(modeStr)
    if (Number.isNaN(mode)) return
    inode.mode = mode
  }

  private applyCopy(destPath: string, content: string): void {
    this.applyCreate(destPath)
    const fileEntry = this.findFileEntry(destPath)
    if (!fileEntry) return
    const inode = this.inodes.get(fileEntry.inode!)!
    inode.content = content
    inode.size = content.length
    const neededBlocks = content.length === 0 ? 0 : Math.ceil(content.length / this.config.blockSizeBytes)
    if (neededBlocks > 0) {
      inode.blockIds.push(...this.allocateFreeBlocks(inode.id, neededBlocks))
    }
  }

  private applyCreate(path: string): void {
    if (this.findFileEntry(path)) return
    if (this.findDirEntry(path) || this.findSymlinkEntry(path)) return
    const segments = this.splitPath(path)
    const name = segments.pop()
    if (!name) return
    const dir = this.resolveDir(segments, true)
    const inode: InternalInode = {
      id: this.nextInodeId++,
      size: 0,
      blockIds: [],
      links: 1,
      content: '',
      mode: DEFAULT_FILE_MODE,
    }
    this.inodes.set(inode.id, inode)
    dir.children!.push({ name, type: 'file', inode: inode.id })
  }

  private applyWrite(path: string, text: string, skipPermissionCheck = false): void {
    let fileEntry = this.findFileEntry(path)
    if (!fileEntry) {
      this.applyCreate(path)
      fileEntry = this.findFileEntry(path)
      if (!fileEntry) return
    }
    const inode = this.inodes.get(fileEntry.inode!)!
    if (!skipPermissionCheck && !(inode.mode & MODE_WRITE)) return
    inode.content += text
    inode.size = inode.content.length

    const neededBlocks = inode.content.length === 0 ? 0 : Math.ceil(inode.content.length / this.config.blockSizeBytes)
    if (neededBlocks > inode.blockIds.length) {
      const grow = neededBlocks - inode.blockIds.length
      const newBlocks = this.allocateFreeBlocks(inode.id, grow)
      inode.blockIds.push(...newBlocks)
    }
  }

  private applyDelete(path: string, skipPermissionCheck = false): void {
    const symlinkEntry = this.findSymlinkEntry(path)
    if (symlinkEntry) {
      const linkSegments = this.splitPath(path)
      linkSegments.pop()
      const linkDir = this.resolveDir(linkSegments, false)
      if (linkDir?.children) linkDir.children = linkDir.children.filter((c) => c !== symlinkEntry)
      return
    }
    const fileEntry = this.findFileEntry(path)
    if (!fileEntry) return
    const inode = this.inodes.get(fileEntry.inode!)
    if (inode && !skipPermissionCheck && !(inode.mode & MODE_WRITE)) return
    if (inode) {
      inode.links--
      if (inode.links <= 0) {
        for (const blockIndex of inode.blockIds) {
          this.releaseBlock(blockIndex)
          this.ioScheduler.enqueue(blockIndex, 'write', this.tick)
        }
        this.inodes.delete(inode.id)
      }
    }
    const segments = this.splitPath(path)
    const name = segments.pop()!
    const dir = this.resolveDir(segments, false)
    if (dir?.children) dir.children = dir.children.filter((c) => c.name !== name)
  }

  private allocateFreeBlocks(inodeId: number, count: number): number[] {
    if (count <= 0 || count > this.freeSpace.freeCount) return []
    const allocated: number[] = []
    let next = 0
    while (allocated.length < count) {
      next = this.freeSpace.findFirstFree(next)
      if (next === -1) break
      this.claimBlock(next, inodeId)
      allocated.push(next)
      next++
    }
    for (const blockIndex of allocated) this.ioScheduler.enqueue(blockIndex, 'write', this.tick)
    return allocated
  }

  private splitPath(path: string): string[] {
    return path.split('/').filter(Boolean)
  }

  private static readonly MAX_SYMLINK_DEPTH = 8

  private static collapse(segments: string[]): string[] {
    const out: string[] = []
    for (const seg of segments) {
      if (seg === '.') continue
      if (seg === '..') out.pop()
      else out.push(seg)
    }
    return out
  }

  /**
   * Rewrites a path with every symlink along it replaced by its target, so
   * everything below works on plain link-free paths.
   *
   * `followFinal` is the load-bearing part: `cat link` wants the target,
   * `rm link` and `mv link` want the link itself. A component that doesn't
   * exist stops resolution and the rest is returned untouched, which is
   * also what makes a dangling link report correctly.
   */
  private resolveLinks(path: string, followFinal: boolean, depth = 0): { ok: true; path: string } | { ok: false; error: string } {
    if (depth > FilesystemEngine.MAX_SYMLINK_DEPTH) {
      return { ok: false, error: `${path}: Too many levels of symbolic links` }
    }
    const segments = this.splitPath(path)
    const out: string[] = []
    let dir: DirEntry = this.root

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!
      const child = dir.children?.find((c) => c.name === seg)
      const isFinal = i === segments.length - 1

      if (!child) {
        out.push(...segments.slice(i))
        break
      }

      if (child.type === 'symlink' && (!isFinal || followFinal)) {
        const target = child.target ?? ''
        const base = target.startsWith('/') ? this.splitPath(target) : [...out, ...this.splitPath(target)]
        const combined = FilesystemEngine.collapse([...base, ...segments.slice(i + 1)])
        return this.resolveLinks(`/${combined.join('/')}`, followFinal, depth + 1)
      }

      out.push(seg)
      if (child.type === 'dir') {
        dir = child
      } else {
        out.push(...segments.slice(i + 1))
        break
      }
    }
    return { ok: true, path: `/${out.join('/')}` }
  }

  private resolveDir(segments: string[], create: boolean): DirEntry {
    let node = this.root
    for (const seg of segments) {
      node.children = node.children ?? []
      let child = node.children.find((c) => c.name === seg && c.type === 'dir')
      if (!child) {
        if (!create) throw new Error(`no such directory: ${seg}`)
        child = { name: seg, type: 'dir', children: [] }
        node.children.push(child)
      }
      node = child
    }
    return node
  }

  private findFileEntry(path: string): DirEntry | undefined {
    const segments = this.splitPath(path)
    const name = segments.pop()
    if (!name) return undefined
    let dir: DirEntry
    try {
      dir = this.resolveDir(segments, false)
    } catch {
      return undefined
    }
    return dir.children?.find((c) => c.name === name && c.type === 'file')
  }

  private ancestorIsFile(path: string): boolean {
    const segments = this.splitPath(path)
    segments.pop()
    let node = this.root
    for (const seg of segments) {
      const child = node.children?.find((c) => c.name === seg)
      if (!child) return false
      if (child.type === 'file') return true
      node = child
    }
    return false
  }

  private growthExceedsFreeSpace(path: string, text: string): boolean {
    const existing = this.findFileEntry(path)
    const currentContent = existing ? this.inodes.get(existing.inode!)!.content : ''
    const currentBlocks = existing ? this.inodes.get(existing.inode!)!.blockIds.length : 0
    const newLength = currentContent.length + text.length
    const neededBlocks = newLength === 0 ? 0 : Math.ceil(newLength / this.config.blockSizeBytes)
    const grow = Math.max(0, neededBlocks - currentBlocks)
    return grow > this.freeSpace.freeCount
  }

  private findSymlinkEntry(path: string): DirEntry | undefined {
    const segments = this.splitPath(path)
    const name = segments.pop()
    if (!name) return undefined
    let dir: DirEntry
    try {
      dir = this.resolveDir(segments, false)
    } catch {
      return undefined
    }
    return dir.children?.find((c) => c.name === name && c.type === 'symlink')
  }

  private findDirEntry(path: string): DirEntry | undefined {
    const segments = this.splitPath(path)
    const name = segments.pop()
    if (!name) return undefined
    let dir: DirEntry
    try {
      dir = this.resolveDir(segments, false)
    } catch {
      return undefined
    }
    return dir.children?.find((c) => c.name === name && c.type === 'dir')
  }

  private trimJournal(): void {
    if (this.journal.length > this.config.journalHistoryLimit) {
      this.journal.splice(0, this.journal.length - this.config.journalHistoryLimit)
    }
  }

  getTree(): DirEntry {
    return this.root
  }

  getBlocks(): DiskBlock[] {
    return this.blocks
  }

  getInodes(): Inode[] {
    return [...this.inodes.values()].map(({ id, size, blockIds, links, mode }) => ({ id, size, blockIds, links, mode }))
  }

  getJournal(): JournalEntry[] {
    return this.journal
  }

  getIoState(): IoSchedulerState {
    return this.ioScheduler.getState()
  }

  getIoMetrics(): IoSchedulerMetrics {
    return this.ioScheduler.getMetrics()
  }

  getFreeSpaceBitmap(): boolean[] {
    return this.freeSpace.toArray()
  }

  getMetrics() {
    return {
      usedBlocks: this.freeSpace.used,
      freeBlocks: this.freeSpace.freeCount,
      totalBlocks: this.blocks.length,
      pendingJournalEntries: this.journal.filter((e) => e.status === 'pending').length,
    }
  }

  exportState(): FilesystemState {
    return {
      schemaVersion: FS_SCHEMA_VERSION,
      blockCount: this.config.blockCount,
      blocks: this.blocks.map((b) => ({ ...b })),
      inodes: [...this.inodes.values()].map((i) => ({ ...i })),
      root: structuredClone(this.root),
      journal: this.journal.map((j) => ({ ...j })),
      nextInodeId: this.nextInodeId,
      nextJournalId: this.nextJournalId,
      tick: this.tick,
      crashed: this.crashed,
      lastTouchedPath: this.lastTouchedPath,
    }
  }

  importState(state: FilesystemState): boolean {
    if (state.schemaVersion !== FS_SCHEMA_VERSION) return false
    if (state.blockCount !== this.config.blockCount) return false

    try {
      const blocks = state.blocks.map((b) => ({ ...b }))
      const inodes = new Map(state.inodes.map((i) => [i.id, { ...i }]))
      const root = structuredClone(state.root)
      const journal = state.journal.map((j) => ({ ...j }))

      this.blocks = blocks
      this.inodes = inodes
      this.root = root
      this.journal = journal
      this.nextInodeId = state.nextInodeId
      this.nextJournalId = state.nextJournalId
      this.tick = state.tick
      this.crashed = state.crashed
      this.lastTouchedPath = state.lastTouchedPath
      this.abandonedIoWaiters.push(...this.ioScheduler.reset())
      this.freeSpace.rebuild((index) => this.blocks[index]?.owner != null)
      return true
    } catch {
      return false
    }
  }

  resetToEmpty(): void {
    this.blocks = Array.from({ length: this.config.blockCount }, (_, index) => ({ index, owner: null }))
    this.inodes = new Map()
    this.root = { name: '/', type: 'dir', children: [] }
    this.journal = []
    this.nextInodeId = 1
    this.nextJournalId = 1
    this.tick = 0
    this.crashed = false
    this.lastTouchedPath = null
    this.abandonedIoWaiters.push(...this.ioScheduler.reset())
    this.freeSpace.rebuild(() => false)
  }
}
