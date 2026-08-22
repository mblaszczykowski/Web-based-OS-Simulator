import type { DirEntry, DiskBlock, Inode, JournalEntry, JournalOp } from '../shared/types'
import { simBus } from '../shared/eventBus'
import { IoScheduler, type CompletedIoRequest, type IoSchedulerMetrics, type IoSchedulerState } from './ioScheduler'
import { FreeSpaceBitmap } from './freeSpaceBitmap'

export interface FilesystemConfig {
  blockCount: number
  blockSizeBytes: number
  journalHistoryLimit: number
  /**
   * Cylinders the SCAN head crosses per tick. Optional, defaulting to the
   * plain one-cylinder-per-tick model every hand-traced test in this
   * module is written against; the live engine runs it faster — see
   * DEFAULT_FS_CONFIG and IoScheduler's constructor for why.
   */
  seekCylindersPerTick?: number
}

export const DEFAULT_FS_CONFIG: FilesystemConfig = {
  blockCount: 64,
  blockSizeBytes: 64,
  journalHistoryLimit: 50,
  // A full 64-cylinder sweep therefore takes 16 ticks, so an average
  // request waits ~8 — the same order of magnitude as the CPU bursts it
  // interleaves with (generateBursts() in scheduler/engine.ts), now that
  // processes genuinely block on these requests (roadmap-v5.md §1.1).
  seekCylindersPerTick: 4,
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
  /** See drainAbandonedIoWaiters(). */
  private abandonedIoWaiters: number[] = []
  /**
   * The authority on which blocks are free — roadmap-v5.md §2.2. Kept in
   * lockstep with `blocks[].owner` by claimBlock()/releaseBlock() below,
   * which are the only two places allowed to change either.
   */
  private freeSpace: FreeSpaceBitmap

  constructor(private config: FilesystemConfig = DEFAULT_FS_CONFIG) {
    this.blocks = Array.from({ length: config.blockCount }, (_, index) => ({ index, owner: null }))
    this.ioScheduler = new IoScheduler(config.blockCount, config.seekCylindersPerTick ?? 1)
    this.freeSpace = new FreeSpaceBitmap(config.blockCount)
  }

  /**
   * The only place a block becomes allocated, and the only place it
   * becomes free again. Both representations — the bitmap that decides
   * availability and the owner field the grid renders — are updated here
   * together, so they cannot drift apart.
   */
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

  /**
   * Advances the disk by one tick and returns everything the head
   * serviced. Processes blocked on those requests (roadmap-v5.md §1.1)
   * are woken by the caller in app/engines.ts — this engine stays
   * scheduler-unaware, exactly like it stays memory-unaware for swap.
   */
  advanceTick(): CompletedIoRequest[] {
    this.tick++
    return this.ioScheduler.step(this.tick)
  }

  /**
   * Submits one I/O request on behalf of a process that is about to block
   * on it — roadmap-v5.md §1.1. Distinct from the filesystem's own
   * internal enqueues (block allocation, `cat`'s read) in exactly one way:
   * it carries the waiter's pid, so completing it can release that
   * process. Returns false if the request can't be queued at all, which is
   * the caller's signal to fall back rather than block a process forever.
   */
  requestDeviceIo(blockIndex: number, kind: 'read' | 'write', waiterPid: number): boolean {
    return this.ioScheduler.enqueue(blockIndex, kind, this.tick, waiterPid)
  }

  /**
   * Pids that were blocked on a request the disk queue threw away (a
   * `reset-fs`, or a cross-tab import replacing the disk under them).
   * Drained by the caller each tick and woken — without this they would
   * sit in WAITING forever, since the only event that could ever release
   * them was discarded along with the queue.
   */
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
    // The directory being created is the final component, so it is never
    // followed — but the path leading to it may run through symlinks.
    const resolved = this.resolveLinks(path, false)
    if (!resolved.ok) return { ok: false, error: `mkdir: ${resolved.error}` }
    if (this.findFileEntry(resolved.path) || this.findDirEntry(resolved.path) || this.findSymlinkEntry(resolved.path)) {
      return { ok: false, error: `mkdir: ${path}: File exists` }
    }
    if (this.ancestorIsFile(resolved.path)) return { ok: false, error: `mkdir: ${path}: Not a directory` }

    this.commitJournalEntry('mkdir', { path: resolved.path, touchedPath: resolved.path })
    return { ok: true }
  }

  /** Moves/renames a file (not a directory — kept in scope with the rest of this shell's file ops). */
  move(srcPath: string, destPath: string): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    // Neither end follows its final component: `mv link elsewhere` moves
    // the link, it does not move what the link points at.
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
    // A hard link points at an inode, so its source IS followed through a
    // symlink — the new name ends up on the real file, not on the link.
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
   * Creates a symbolic link at `linkPath` pointing at `targetPath` —
   * roadmap-v5.md §2.2, `ln -s`. Unlike link() next door, the target is
   * neither resolved nor required to exist: a symlink stores a *name*, and
   * a dangling one is a legal and useful thing (it starts working the
   * moment its target is created). That is the whole difference from the
   * hard link this sits beside.
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

  /** Sets the rwx mode on `path`'s inode — roadmap-v3.md §2.3. `mode` must already be a validated 0-7 bitmask (see commands.ts's parseMode). */
  chmod(path: string, mode: number): FsResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    // Permissions live on the inode, and a symlink has none — so chmod
    // follows it through to the file it names, like the real one does.
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
    // `cp` copies content, so the source is followed; the destination is
    // a new name and never is.
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
      // A symlink carries its target rather than a mode or a size — it has
      // neither, and the target is the only thing worth showing for one.
      if (c.type === 'symlink') return { name: c.name, type: c.type, target: c.target }
      return { name: c.name, type: c.type }
    })
    return { ok: true, entries }
  }

  read(path: string): FsReadResult {
    const crashedError = this.rejectIfCrashed()
    if (crashedError) return crashedError
    // Reading through a symlink reads its target — roadmap-v5.md §2.2.
    const resolved = this.resolveLinks(path, true)
    if (!resolved.ok) return { ok: false, error: `cat: ${resolved.error}` }
    path = resolved.path
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

    // Writing through a symlink writes its target; `rm link` removes the
    // link and leaves the target alone (roadmap-v5.md §2.2). Getting the
    // delete case wrong is how `rm` on a symlink deletes the wrong file.
    const resolved = this.resolveLinks(path, op !== 'delete')
    if (!resolved.ok) return { ok: false, error: `${op}: ${resolved.error}` }
    path = resolved.path

    // `rm` on a symlink removes the link itself — it owns no inode and no
    // blocks, so this is a pure directory-entry removal and never touches
    // whatever it pointed at.
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
      case 'symlink':
        return this.applySymlink(path, target!)
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

  /**
   * `path` is the link's own location and `target` is what it points at,
   * stored verbatim. Note the argument order is the reverse of
   * applyLink()'s: a hard link needs its source to exist and is created
   * *from* it, while a symlink is just a name holding a string and is
   * perfectly legal when its target doesn't exist at all.
   */
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
    // Guards against a stale 'write'/'create' replay whose target is
    // actually something other than a file — e.g. `mkdir /d` sets
    // lastTouchedPath to '/d', and crash()'s fabricated journal entry is
    // always op:'write' regardless of what lastTouchedPath actually is.
    // Without this, fsck() replaying that entry via applyWrite ->
    // applyCreate would push a second, same-named file entry alongside
    // the existing one — two siblings named 'd', tree corrupted.
    //
    // The symlink half of this was missed when links were added
    // (roadmap-v5.md §2.2) and is reachable the same way: `ln -s`, and
    // `mv` of a link, both set lastTouchedPath to the link, so
    // `ln -s /notes.txt /link; crash; fsck` produced a phantom '/link'
    // file beside the real symlink — holding an inode and disk blocks
    // nothing could ever reach again (found by code review).
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
    // A symlink is a name and nothing else: no inode, no blocks, no
    // permission bits to check — removing the directory entry is the
    // whole operation (roadmap-v5.md §2.2).
    const symlinkEntry = this.findSymlinkEntry(path)
    if (symlinkEntry) {
      const linkSegments = this.splitPath(path)
      linkSegments.pop() // the link's own name; the entry itself is matched by identity below
      const linkDir = this.resolveDir(linkSegments, false)
      if (linkDir?.children) linkDir.children = linkDir.children.filter((c) => c !== symlinkEntry)
      return
    }
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
          this.releaseBlock(blockIndex)
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

  /**
   * Claims `count` blocks for an inode, walking the free-space bit vector
   * (roadmap-v5.md §2.2) rather than scanning every DiskBlock. All or
   * nothing: a partial allocation would leave an inode holding fewer
   * blocks than its content needs, which no caller here is prepared for.
   * Every caller has already checked free space itself, so this only
   * fires if that check and this one ever disagree.
   */
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

  /**
   * How many links deep resolution will go before giving up — the ELOOP
   * limit every real kernel has, for exactly the same reason: `ln -s /a /a`
   * is legal to create and impossible to follow.
   */
  private static readonly MAX_SYMLINK_DEPTH = 8

  /** Collapses `.`/`..` inside a symlink target, which is written by the user and may contain either. */
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
   * Rewrites `path` with every symbolic link along it replaced by what it
   * points at — roadmap-v5.md §2.2. Everything below this method then
   * works on plain, link-free paths, which is why symlinks needed no
   * changes to `resolveDir`, `findFileEntry`, the journal or replay.
   *
   * `followFinal` distinguishes the two things a caller can mean by a path
   * that names a link. `cat link` wants the target (true); `rm link`,
   * `mv link`, and creating a link in the first place want the link itself
   * (false). Getting this backwards is how `rm` on a symlink deletes the
   * wrong file.
   *
   * A component that doesn't exist stops resolution and the rest of the
   * path is returned unchanged — the caller's own existence check reports
   * it. That is also what makes a dangling symlink behave correctly:
   * following it lands on a name that isn't there, and the caller says so.
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
        // Nothing here (yet) — leave the remainder alone.
        out.push(...segments.slice(i))
        break
      }

      if (child.type === 'symlink' && (!isFinal || followFinal)) {
        const target = child.target ?? ''
        // An absolute target restarts from the root; a relative one is
        // interpreted against the directory the link lives in, which is
        // what makes `ln -s notes.txt here` work the way it reads.
        const base = target.startsWith('/') ? this.splitPath(target) : [...out, ...this.splitPath(target)]
        const combined = FilesystemEngine.collapse([...base, ...segments.slice(i + 1)])
        return this.resolveLinks(`/${combined.join('/')}`, followFinal, depth + 1)
      }

      out.push(seg)
      if (child.type === 'dir') {
        dir = child
      } else {
        // A file (or an unfollowed link) mid-path: the caller's own
        // ancestorIsFile()/existence checks are what reject that, so the
        // remainder is passed through untouched.
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
    return grow > this.freeSpace.freeCount
  }

  /** The symlink entry at `path`, if the final component is one. Never follows it — see resolveLinks(). */
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

  /** The free-space bit vector, allocated = true — roadmap-v5.md §2.2. */
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
      this.abandonedIoWaiters.push(...this.ioScheduler.reset())
      // Ground truth for a freshly imported disk is the blocks it came
      // with, so the bitmap is rebuilt from them rather than carried over.
      this.freeSpace.rebuild((index) => this.blocks[index]?.owner != null)
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
    this.abandonedIoWaiters.push(...this.ioScheduler.reset())
    this.freeSpace.rebuild(() => false)
  }
}
