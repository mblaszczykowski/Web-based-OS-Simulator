import type { DirEntry, DiskBlock, Inode, JournalEntry, JournalOp } from '../shared/types'

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
  }

  /** Replay every pending journal entry (fsck / next mount). Returns the entries it replayed. */
  fsck(): { replayed: JournalEntry[] } {
    const pending = this.journal.filter((entry) => entry.status === 'pending')
    for (const entry of pending) {
      this.apply(entry.op, entry.path, entry.content ?? '')
      entry.status = 'committed'
    }
    this.crashed = false
    return { replayed: pending }
  }

  private mutate(op: JournalOp, path: string, content?: string): FsResult {
    if (this.crashed) return { ok: false, error: 'filesystem is in a crashed state — run `fsck` to recover' }

    if (op === 'delete' && !this.findFileEntry(path)) {
      return { ok: false, error: `rm: ${path}: No such file or directory` }
    }
    if (op === 'create' && this.findFileEntry(path)) {
      return { ok: false, error: `create: ${path}: already exists` }
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
    return { ok: true }
  }

  private apply(op: JournalOp, path: string, content: string): void {
    if (op === 'create') this.applyCreate(path)
    else if (op === 'write') this.applyWrite(path, content)
    else this.applyDelete(path)
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
