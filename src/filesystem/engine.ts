import type { DirEntry, DiskBlock, Inode, JournalEntry, JournalOp } from '../shared/types'
import { simBus } from '../shared/eventBus'

export interface FilesystemConfig {
  blockCount: number
  blockSizeBytes: number
  journalHistoryLimit: number
}

export const DEFAULT_FS_CONFIG: FilesystemConfig = {
  blockCount: 64,
  blockSizeBytes: 64,
  journalHistoryLimit: 50,
}

export type FsResult = { ok: true } | { ok: false; error: string }
export type FsReadResult = { ok: true; content: string } | { ok: false; error: string }

interface InternalInode extends Inode {
  content: string
}

/**
 * A small inode-based filesystem over a simulated block device, with a
 * write-ahead log so a "crash" mid-write can be replayed back to a
 * consistent state on the next mount — see plan.md §2.3. This intentionally
 * does not aim for the crash-consistency guarantees of a real journaling
 * fs; it exists to demonstrate the idea (log-before-write, replay pending
 * entries) rather than to be production-grade.
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

  constructor(private config: FilesystemConfig = DEFAULT_FS_CONFIG) {
    this.blocks = Array.from({ length: config.blockCount }, (_, index) => ({ index, owner: null }))
  }

  advanceTick(): void {
    this.tick++
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

  mkdir(path: string): FsResult {
    if (this.crashed) return { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' }
    if (this.findFileEntry(path) || this.findDirEntry(path)) {
      return { ok: false, error: `mkdir: ${path}: File exists` }
    }
    if (this.ancestorIsFile(path)) return { ok: false, error: `mkdir: ${path}: Not a directory` }

    const entry: JournalEntry = { id: this.nextJournalId++, op: 'mkdir', path, status: 'pending', tick: this.tick }
    this.journal.push(entry)
    this.trimJournal()
    this.applyMkdir(path)
    entry.status = 'committed'
    this.lastTouchedPath = path
    simBus.emit('fs:mutated', { op: 'mkdir', path })
    return { ok: true }
  }

  /** Moves/renames a file (not a directory — kept in scope with the rest of this shell's file ops). */
  move(srcPath: string, destPath: string): FsResult {
    if (this.crashed) return { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' }
    if (this.findDirEntry(srcPath)) return { ok: false, error: `mv: ${srcPath}: Is a directory` }
    if (!this.findFileEntry(srcPath)) return { ok: false, error: `mv: ${srcPath}: No such file or directory` }
    if (this.findFileEntry(destPath) || this.findDirEntry(destPath)) {
      return { ok: false, error: `mv: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(destPath)) return { ok: false, error: `mv: ${destPath}: Not a directory` }

    const entry: JournalEntry = {
      id: this.nextJournalId++,
      op: 'move',
      path: srcPath,
      target: destPath,
      status: 'pending',
      tick: this.tick,
    }
    this.journal.push(entry)
    this.trimJournal()
    this.applyMove(srcPath, destPath)
    entry.status = 'committed'
    this.lastTouchedPath = destPath
    simBus.emit('fs:mutated', { op: 'move', path: destPath })
    return { ok: true }
  }

  copy(srcPath: string, destPath: string): FsResult {
    if (this.crashed) return { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' }
    if (this.findDirEntry(srcPath)) return { ok: false, error: `cp: ${srcPath}: Is a directory` }
    const srcEntry = this.findFileEntry(srcPath)
    if (!srcEntry) return { ok: false, error: `cp: ${srcPath}: No such file or directory` }
    if (this.findFileEntry(destPath) || this.findDirEntry(destPath)) {
      return { ok: false, error: `cp: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(destPath)) return { ok: false, error: `cp: ${destPath}: Not a directory` }

    const content = this.inodes.get(srcEntry.inode!)!.content
    const neededBlocks = content.length === 0 ? 0 : Math.ceil(content.length / this.config.blockSizeBytes)
    const freeBlocks = this.blocks.filter((b) => b.owner === null).length
    if (neededBlocks > freeBlocks) return { ok: false, error: `cp: ${destPath}: No space left on device` }

    const entry: JournalEntry = {
      id: this.nextJournalId++,
      op: 'copy',
      path: destPath,
      content,
      target: srcPath,
      status: 'pending',
      tick: this.tick,
    }
    this.journal.push(entry)
    this.trimJournal()
    this.applyCopy(destPath, content)
    entry.status = 'committed'
    this.lastTouchedPath = destPath
    simBus.emit('fs:mutated', { op: 'copy', path: destPath })
    return { ok: true }
  }

  list(path = '/'): { ok: true; entries: { name: string; type: DirEntry['type'] }[] } | { ok: false; error: string } {
    if (this.crashed) return { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' }
    let dir: DirEntry
    try {
      dir = this.resolveDir(this.splitPath(path), false)
    } catch {
      return { ok: false, error: `ls: ${path}: No such file or directory` }
    }
    const entries = (dir.children ?? []).map((c) => ({ name: c.name, type: c.type }))
    return { ok: true, entries }
  }

  read(path: string): FsReadResult {
    if (this.crashed) return { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' }
    const entry = this.findFileEntry(path)
    if (!entry) return { ok: false, error: `cat: ${path}: No such file or directory` }
    const inode = this.inodes.get(entry.inode!)!
    return { ok: true, content: inode.content }
  }

  /** Simulate power loss mid-write: log an entry describing the write but never apply it. */
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

  /** Replay every pending journal entry (fsck / next mount). Returns the entries it replayed. */
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

  private mutate(op: JournalOp, path: string, content?: string): FsResult {
    if (this.crashed) return { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' }

    if ((op === 'create' || op === 'write') && this.findDirEntry(path)) {
      return { ok: false, error: `${op}: ${path}: Is a directory` }
    }
    if ((op === 'create' || op === 'write') && this.ancestorIsFile(path)) {
      return { ok: false, error: `${op}: ${path}: Not a directory` }
    }
    if (op === 'delete') {
      if (this.findDirEntry(path)) return { ok: false, error: `rm: ${path}: Is a directory` }
      if (!this.findFileEntry(path)) return { ok: false, error: `rm: ${path}: No such file or directory` }
    }
    if (op === 'create' && this.findFileEntry(path)) {
      return { ok: false, error: `create: ${path}: already exists` }
    }
    if (op === 'write' && this.growthExceedsFreeSpace(path, content ?? '')) {
      return { ok: false, error: `write: ${path}: No space left on device` }
    }

    const entry: JournalEntry = {
      id: this.nextJournalId++,
      op,
      path,
      content,
      status: 'pending',
      tick: this.tick,
    }
    this.journal.push(entry)
    this.trimJournal()

    this.apply(op, path, content ?? '')
    entry.status = 'committed'
    if (op !== 'delete') this.lastTouchedPath = path
    simBus.emit('fs:mutated', { op, path })
    return { ok: true }
  }

  private apply(op: JournalOp, path: string, content: string, target?: string): void {
    if (op === 'create') this.applyCreate(path)
    else if (op === 'write') this.applyWrite(path, content)
    else if (op === 'delete') this.applyDelete(path)
    else if (op === 'mkdir') this.applyMkdir(path)
    else if (op === 'move') this.applyMove(path, target!)
    else if (op === 'copy') this.applyCopy(path, content)
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
    const fileEntry = this.findFileEntry(srcPath)
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
    const segments = this.splitPath(path)
    const name = segments.pop()
    if (!name) return
    const dir = this.resolveDir(segments, true)
    const inode: InternalInode = { id: this.nextInodeId++, size: 0, blockIds: [], links: 1, content: '' }
    this.inodes.set(inode.id, inode)
    dir.children!.push({ name, type: 'file', inode: inode.id })
  }

  private applyWrite(path: string, text: string): void {
    let fileEntry = this.findFileEntry(path)
    if (!fileEntry) {
      this.applyCreate(path)
      fileEntry = this.findFileEntry(path)
      if (!fileEntry) return
    }
    const inode = this.inodes.get(fileEntry.inode!)!
    inode.content += text
    inode.size = inode.content.length

    const neededBlocks = inode.content.length === 0 ? 0 : Math.ceil(inode.content.length / this.config.blockSizeBytes)
    if (neededBlocks > inode.blockIds.length) {
      const grow = neededBlocks - inode.blockIds.length
      const newBlocks = this.allocateFreeBlocks(inode.id, grow)
      inode.blockIds.push(...newBlocks)
    }
  }

  private applyDelete(path: string): void {
    const fileEntry = this.findFileEntry(path)
    if (!fileEntry) return
    const inode = this.inodes.get(fileEntry.inode!)
    if (inode) {
      for (const blockIndex of inode.blockIds) {
        const block = this.blocks[blockIndex]
        if (block) block.owner = null
      }
      this.inodes.delete(inode.id)
    }
    const segments = this.splitPath(path)
    const name = segments.pop()!
    const dir = this.resolveDir(segments, false)
    if (dir?.children) dir.children = dir.children.filter((c) => c.name !== name)
  }

  private allocateFreeBlocks(inodeId: number, count: number): number[] {
    const allocated: number[] = []
    for (const block of this.blocks) {
      if (allocated.length >= count) break
      if (block.owner === null) {
        block.owner = inodeId
        allocated.push(block.index)
      }
    }
    return allocated
  }

  private splitPath(path: string): string[] {
    return path.split('/').filter(Boolean)
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

  /**
   * Does any segment BEFORE the final component already exist as a file?
   * resolveDir(..., true) only checks for an existing type:'dir' match by
   * name — if that segment exists but is a file, it would otherwise just
   * create a second, same-named directory entry alongside it rather than
   * erroring, corrupting the tree (two siblings named the same).
   */
  private ancestorIsFile(path: string): boolean {
    const segments = this.splitPath(path)
    segments.pop() // the final component is the file/dir being created — not an ancestor
    let node = this.root
    for (const seg of segments) {
      const child = node.children?.find((c) => c.name === seg)
      if (!child) return false // doesn't exist yet — resolveDir(..., true) will create it
      if (child.type === 'file') return true
      node = child
    }
    return false
  }

  /** Would growing this file by `text` need more blocks than the disk has free? */
  private growthExceedsFreeSpace(path: string, text: string): boolean {
    const existing = this.findFileEntry(path)
    const currentContent = existing ? this.inodes.get(existing.inode!)!.content : ''
    const currentBlocks = existing ? this.inodes.get(existing.inode!)!.blockIds.length : 0
    const newLength = currentContent.length + text.length
    const neededBlocks = newLength === 0 ? 0 : Math.ceil(newLength / this.config.blockSizeBytes)
    const grow = Math.max(0, neededBlocks - currentBlocks)
    const freeBlocks = this.blocks.filter((b) => b.owner === null).length
    return grow > freeBlocks
  }

  /** Does `path` already exist as a directory? Used to reject file ops that would collide with one. */
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
    return [...this.inodes.values()].map(({ id, size, blockIds, links }) => ({ id, size, blockIds, links }))
  }

  getJournal(): JournalEntry[] {
    return this.journal
  }

  getMetrics() {
    const used = this.blocks.filter((b) => b.owner !== null).length
    return {
      usedBlocks: used,
      freeBlocks: this.blocks.length - used,
      totalBlocks: this.blocks.length,
      pendingJournalEntries: this.journal.filter((e) => e.status === 'pending').length,
    }
  }
}
