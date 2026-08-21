import type { DirEntry, DiskBlock, Inode, JournalEntry, JournalOp } from '../shared/types'
import { simBus } from '../shared/eventBus'
import { IoScheduler, type IoSchedulerMetrics, type IoSchedulerState } from './ioScheduler'

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

// File permissions (roadmap-v3.md §2.3) — a single rwx triplet per inode,
// since this simulator has exactly one user (`guest`); there's no
// owner/group/other distinction to model. MODE_EXEC is tracked and shown
// (ls -l, chmod) for a realistic-looking mode string, but nothing in this
// filesystem ever "executes" a file from disk — `run <name>` spawns a
// scheduler process unrelated to any inode — so it's honestly inert,
// exactly like a regular file's +x bit on a real system that never runs it.
export const MODE_READ = 0b100
export const MODE_WRITE = 0b010
export const MODE_EXEC = 0b001
export const DEFAULT_FILE_MODE = MODE_READ | MODE_WRITE // rw- : matches a typical default umask's owner bits

export function rwxTriplet(mode: number): string {
  return `${mode & MODE_READ ? 'r' : '-'}${mode & MODE_WRITE ? 'w' : '-'}${mode & MODE_EXEC ? 'x' : '-'}`
}

/** Bumped whenever the shape of FilesystemState changes, so a persisted disk from an older build gets discarded instead of misread. */
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
  private ioScheduler: IoScheduler

  constructor(private config: FilesystemConfig = DEFAULT_FS_CONFIG) {
    this.blocks = Array.from({ length: config.blockCount }, (_, index) => ({ index, owner: null }))
    this.ioScheduler = new IoScheduler(config.blockCount)
  }

  advanceTick(): void {
    this.tick++
    this.ioScheduler.step(this.tick)
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

  /**
   * write()/delete() that skip the permission check (roadmap-v3.md §2.3
   * still applies to every OTHER caller) — for the memory subsystem's
   * swap-to-disk coordinator (app/engines.ts) only, never exposed through
   * CommandContext/the terminal. `/swap/*` files are kernel-managed
   * bookkeeping, not user data, even though they're deliberately visible
   * for inspection (`ls /swap`, `free`'s hint) — a user chmod'ing one
   * read-only must not be able to permanently leak a disk block by
   * blocking its own cleanup (found by code review).
   */
  writeIgnoringPermissions(path: string, text: string): FsResult {
    return this.mutate('write', path, text, { skipPermissionCheck: true })
  }

  deleteIgnoringPermissions(path: string): FsResult {
    return this.mutate('delete', path, undefined, { skipPermissionCheck: true })
  }

  mkdir(path: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    if (this.findFileEntry(path) || this.findDirEntry(path)) {
      return { ok: false, error: `mkdir: ${path}: File exists` }
    }
    if (this.ancestorIsFile(path)) return { ok: false, error: `mkdir: ${path}: Not a directory` }

    this.commitJournalEntry('mkdir', { path, touchedPath: path })
    return { ok: true }
  }

  /** Moves/renames a file (not a directory — kept in scope with the rest of this shell's file ops). */
  move(srcPath: string, destPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    if (this.findDirEntry(srcPath)) return { ok: false, error: `mv: ${srcPath}: Is a directory` }
    if (!this.findFileEntry(srcPath)) return { ok: false, error: `mv: ${srcPath}: No such file or directory` }
    if (this.findFileEntry(destPath) || this.findDirEntry(destPath)) {
      return { ok: false, error: `mv: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(destPath)) return { ok: false, error: `mv: ${destPath}: Not a directory` }

    this.commitJournalEntry('move', { path: srcPath, target: destPath, touchedPath: destPath })
    return { ok: true }
  }

  /**
   * Creates a second directory entry pointing at the same inode as
   * `srcPath` — a real hard link (roadmap-v3.md §2.1), not a copy:
   * `Inode.links` goes to 2, and the inode (and its blocks) only actually
   * disappears once every linked entry has been `delete()`d — see
   * applyDelete()'s link-count check below.
   */
  link(srcPath: string, destPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    if (this.findDirEntry(srcPath)) return { ok: false, error: `ln: ${srcPath}: hard link not allowed for directory` }
    if (!this.findFileEntry(srcPath)) return { ok: false, error: `ln: ${srcPath}: No such file or directory` }
    if (this.findFileEntry(destPath) || this.findDirEntry(destPath)) {
      return { ok: false, error: `ln: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(destPath)) return { ok: false, error: `ln: ${destPath}: Not a directory` }

    this.commitJournalEntry('link', { path: srcPath, target: destPath, touchedPath: destPath })
    return { ok: true }
  }

  /** Sets the rwx mode on `path`'s inode — roadmap-v3.md §2.3. `mode` must already be a validated 0-7 bitmask (see commands.ts's parseMode). */
  chmod(path: string, mode: number): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    if (this.findDirEntry(path)) return { ok: false, error: `chmod: ${path}: Is a directory` }
    if (!this.findFileEntry(path)) return { ok: false, error: `chmod: ${path}: No such file or directory` }

    this.commitJournalEntry('chmod', { path, content: String(mode), touchedPath: path })
    return { ok: true }
  }

  copy(srcPath: string, destPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    if (this.findDirEntry(srcPath)) return { ok: false, error: `cp: ${srcPath}: Is a directory` }
    const srcEntry = this.findFileEntry(srcPath)
    if (!srcEntry) return { ok: false, error: `cp: ${srcPath}: No such file or directory` }
    const srcInode = this.inodes.get(srcEntry.inode!)!
    if (!(srcInode.mode & MODE_READ)) return { ok: false, error: `cp: ${srcPath}: Permission denied` }
    if (this.findFileEntry(destPath) || this.findDirEntry(destPath)) {
      return { ok: false, error: `cp: ${destPath}: already exists` }
    }
    if (this.ancestorIsFile(destPath)) return { ok: false, error: `cp: ${destPath}: Not a directory` }

    const content = srcInode.content
    const neededBlocks = content.length === 0 ? 0 : Math.ceil(content.length / this.config.blockSizeBytes)
    const freeBlocks = this.blocks.filter((b) => b.owner === null).length
    if (neededBlocks > freeBlocks) return { ok: false, error: `cp: ${destPath}: No space left on device` }

    this.commitJournalEntry('copy', { path: destPath, content, target: srcPath, touchedPath: destPath })
    return { ok: true }
  }

  list(
    path = '/',
  ): { ok: true; entries: { name: string; type: DirEntry['type']; mode?: number; size?: number }[] } | { ok: false; error: string } {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    let dir: DirEntry
    try {
      dir = this.resolveDir(this.splitPath(path), false)
    } catch {
      return { ok: false, error: `ls: ${path}: No such file or directory` }
    }
    const entries = (dir.children ?? []).map((c) => {
      if (c.type === 'file') {
        const inode = this.inodes.get(c.inode!)
        return { name: c.name, type: c.type, mode: inode?.mode, size: inode?.size }
      }
      return { name: c.name, type: c.type }
    })
    return { ok: true, entries }
  }

  read(path: string): FsReadResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    const entry = this.findFileEntry(path)
    if (!entry) return { ok: false, error: `cat: ${path}: No such file or directory` }
    const inode = this.inodes.get(entry.inode!)!
    if (!(inode.mode & MODE_READ)) return { ok: false, error: `cat: ${path}: Permission denied` }
    // Simplification: content lives directly on the inode (not read block by
    // block — see the class comment), so a real per-block read trace isn't
    // possible here. Enqueuing one 'read' against the file's first block is
    // enough to make `cat` show up as disk activity in the I/O scheduler
    // without pretending this models byte-accurate block I/O.
    if (inode.blockIds.length > 0) this.ioScheduler.enqueue(inode.blockIds[0]!, 'read', this.tick)
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

  private mutate(op: JournalOp, path: string, content?: string, opts: { skipPermissionCheck?: boolean } = {}): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError

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
    // Permission check (roadmap-v3.md §2.3) — only meaningful against an
    // EXISTING file: writing a brand-new one has nothing to deny yet (it
    // gets DEFAULT_FILE_MODE once applyCreate() actually makes it), and
    // rm's existence check above guarantees the file is there by this point.
    // Skipped for the swap coordinator's internal calls — see
    // writeIgnoringPermissions()/deleteIgnoringPermissions() above.
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

  /**
   * Shared tail for every mutating op (mutate()'s create/write/delete, and
   * mkdir/move/copy): log it pending, apply it, mark it committed, update
   * lastTouchedPath, and announce it. Every caller has already done its
   * own op-specific validation by this point — this only ever runs on an
   * operation that's going to succeed. `skipPermissionCheck` only ever
   * comes from mutate() forwarding writeIgnoringPermissions()/
   * deleteIgnoringPermissions()'s own opt-out — fsck()'s replay call
   * below never passes it, so a replayed entry is always re-checked
   * against the file's CURRENT mode regardless of what let the original
   * write commit (see applyWrite()/applyDelete()).
   */
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
      case 'chmod':
        return this.applyChmod(path, content)
      default: {
        // Exhaustiveness check: a future JournalOp member missing a case
        // above fails to compile here. At runtime this only fires for an
        // `op` that isn't one of the known literals at all — possible only
        // via a corrupted persisted journal entry (fsck() replay reads
        // straight from imported state) — and skipping it is the correct
        // "reject, don't corrupt" behavior, consistent with importState().
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
    // Guards against a stale 'write'/'create' replay whose target now
    // resolves to a directory instead — e.g. `mkdir /d` sets
    // lastTouchedPath to '/d', and crash()'s fabricated journal entry is
    // always op:'write' regardless of what lastTouchedPath actually is.
    // Without this, fsck() replaying that entry via applyWrite ->
    // applyCreate would push a second, same-named file entry alongside
    // the existing directory — two siblings named 'd', tree corrupted.
    if (this.findDirEntry(path)) return
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
    // write()/mutate() already check this for a normal call, but fsck()
    // always calls apply() with skipPermissionCheck left at its default
    // (false) — without this, crash()+fsck() could silently bypass the
    // write-permission check entirely (crash() always fabricates a
    // generic 'write' op against whatever path was last touched,
    // regardless of its current mode — found by code review).
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
    const fileEntry = this.findFileEntry(path)
    if (!fileEntry) return
    const inode = this.inodes.get(fileEntry.inode!)
    // Same reasoning as applyWrite() above — fsck() replay must not be
    // able to bypass the write-permission check that gates a normal rm().
    if (inode && !skipPermissionCheck && !(inode.mode & MODE_WRITE)) return
    if (inode) {
      // A hard-linked file (roadmap-v3.md §2.1) has more than one
      // directory entry pointing at this inode — only the entry named by
      // `path` is removed below; the inode (and its blocks) survives
      // until its link count actually reaches zero.
      inode.links--
      if (inode.links <= 0) {
        for (const blockIndex of inode.blockIds) {
          const block = this.blocks[blockIndex]
          if (block) block.owner = null
          // Freeing a block is still a physical touch of it (clearing its
          // owner) — modeled as a 'write' for scheduling purposes, same as
          // allocation; there's no separate "erase" kind worth adding.
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
    const allocated: number[] = []
    for (const block of this.blocks) {
      if (allocated.length >= count) break
      if (block.owner === null) {
        block.owner = inodeId
        allocated.push(block.index)
      }
    }
    for (const blockIndex of allocated) this.ioScheduler.enqueue(blockIndex, 'write', this.tick)
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
    return [...this.inodes.values()].map(({ id, size, blockIds, links, mode }) => ({ id, size, blockIds, links, mode }))
  }

  getJournal(): JournalEntry[] {
    return this.journal
  }

  /** SCAN disk-head state (pending queue, position, direction) — roadmap-v4.md §1.1. */
  getIoState(): IoSchedulerState {
    return this.ioScheduler.getState()
  }

  getIoMetrics(): IoSchedulerMetrics {
    return this.ioScheduler.getMetrics()
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

  /** Serializes everything needed to reconstruct this disk exactly — see roadmap.md §1.5. */
  exportState(): FilesystemState {
    return {
      schemaVersion: FS_SCHEMA_VERSION,
      blockCount: this.config.blockCount,
      blocks: this.blocks.map((b) => ({ ...b })),
      inodes: [...this.inodes.values()].map((i) => ({ ...i })),
      // Deep-cloned: root is a nested tree, and this must be an independent
      // point-in-time snapshot — a shared reference would let later
      // mutations on this engine (or on another engine imported from the
      // same snapshot) silently leak into whatever holds the exported object.
      root: structuredClone(this.root),
      journal: this.journal.map((j) => ({ ...j })),
      nextInodeId: this.nextInodeId,
      nextJournalId: this.nextJournalId,
      tick: this.tick,
      crashed: this.crashed,
      lastTouchedPath: this.lastTouchedPath,
    }
  }

  /**
   * Restores a previously-exported disk. Rejects (returns false, changes
   * nothing) if the schema version or block count don't match this
   * engine's config — a persisted disk from a stale build is discarded
   * rather than misread, matching the "fallback: fresh empty disk" call in
   * roadmap.md §1.5.
   */
  importState(state: FilesystemState): boolean {
    if (state.schemaVersion !== FS_SCHEMA_VERSION) return false
    if (state.blockCount !== this.config.blockCount) return false

    // A persisted record can pass the two checks above (right schema
    // version, right block count) and still be malformed in some other
    // way — e.g. hand-edited, corrupted by a browser crash mid-write, or
    // written by a build with a bug. Build the replacement state in local
    // variables first and only assign it to `this` once every step has
    // succeeded, so a mid-import throw can never leave the engine
    // half-imported (blocks replaced, inodes not) and never escapes to
    // the caller — "rejects, changes nothing" holds even for malformed
    // input, not just a version/count mismatch.
    try {
      const blocks = state.blocks.map((b) => ({ ...b }))
      const inodes = new Map(state.inodes.map((i) => [i.id, { ...i }]))
      const root = structuredClone(state.root) // independent copy — see the note in exportState()
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
      // Pending I/O requests reference block indices under the disk that
      // just got replaced — transient scheduling state, deliberately not
      // part of FilesystemState/exportState() (same category as the live
      // process/frame state the scheduler and memory engines never
      // persist either), so it's reset rather than carried over stale.
      this.ioScheduler.reset()
      return true
    } catch {
      return false
    }
  }

  /** Wipes the disk back to a fresh, empty state in place — used by the `reset-fs` escape hatch. */
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
    this.ioScheduler.reset()
  }
}
