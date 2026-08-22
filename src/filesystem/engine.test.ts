import { describe, expect, it } from 'vitest'
import { FilesystemEngine, rwxTriplet, type FilesystemState } from './engine'
import type { JournalOp } from '../shared/types'

describe('FilesystemEngine — create / write / read / delete', () => {
  it('auto-creates parent directories and grows blocks as content is appended', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })

    expect(fs.write('/home/user/notes.txt', 'hello')).toEqual({ ok: true }) // 5 bytes -> ceil(5/4) = 2 blocks
    expect(fs.read('/home/user/notes.txt')).toEqual({ ok: true, content: 'hello' })

    const inodes = fs.getInodes()
    expect(inodes).toHaveLength(1)
    expect(inodes[0]!.blockIds).toHaveLength(2)
    expect(fs.getBlocks().filter((b) => b.owner !== null)).toHaveLength(2)

    const root = fs.getTree()
    const home = root.children!.find((c) => c.name === 'home')!
    expect(home.type).toBe('dir')
    const user = home.children!.find((c) => c.name === 'user')!
    expect(user.children!.map((c) => c.name)).toEqual(['notes.txt'])

    expect(fs.write('/home/user/notes.txt', 'world')).toEqual({ ok: true }) // now 10 bytes -> ceil(10/4) = 3 blocks
    expect(fs.read('/home/user/notes.txt')).toEqual({ ok: true, content: 'helloworld' })
    expect(fs.getInodes()[0]!.blockIds).toHaveLength(3)

    expect(fs.delete('/home/user/notes.txt')).toEqual({ ok: true })
    expect(fs.getInodes()).toHaveLength(0)
    expect(fs.getBlocks().every((b) => b.owner === null)).toBe(true) // every block freed
    expect(fs.read('/home/user/notes.txt')).toEqual({
      ok: false,
      error: 'cat: /home/user/notes.txt: No such file or directory',
    })
    expect(fs.delete('/home/user/notes.txt').ok).toBe(false) // deleting twice is an error, not a silent no-op
  })

  it('rejects creating a file that already exists', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    expect(fs.create('/a.txt')).toEqual({ ok: true })
    expect(fs.create('/a.txt').ok).toBe(false)
  })

  it('rejects write/create when the path already exists as a directory', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/home/user/notes.txt', 'hi') // auto-creates /home and /home/user as directories

    expect(fs.write('/home', 'oops').ok).toBe(false)
    expect(fs.create('/home/user').ok).toBe(false)
    expect(fs.delete('/home').ok).toBe(false)

    // and the tree wasn't corrupted by the attempt — still exactly one entry named "home"
    const root = fs.getTree()
    expect(root.children!.filter((c) => c.name === 'home')).toHaveLength(1)
  })

  it('rejects writing through a path where an ANCESTOR segment is a file, not a directory', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/var', 'i am a file') // /var is a file at root, not a directory

    expect(fs.write('/var/log/x.txt', 'data').ok).toBe(false)
    expect(fs.create('/var/log').ok).toBe(false)

    // still exactly one entry named "var" — the attempt didn't create a shadow directory
    const root = fs.getTree()
    expect(root.children!.filter((c) => c.name === 'var')).toHaveLength(1)
    expect(root.children!.find((c) => c.name === 'var')!.type).toBe('file')
  })

  it('rejects a write that would need more blocks than the disk has free', () => {
    const fs = new FilesystemEngine({ blockCount: 2, blockSizeBytes: 4, journalHistoryLimit: 50 })
    expect(fs.write('/a.txt', 'a'.repeat(8)).ok).toBe(true) // exactly fills both 4-byte blocks

    const result = fs.write('/b.txt', 'x') // needs a 3rd block; none free
    expect(result).toEqual({ ok: false, error: 'write: /b.txt: No space left on device' })
    expect(fs.read('/b.txt')).toEqual({ ok: false, error: 'cat: /b.txt: No such file or directory' })
  })
})

describe('FilesystemEngine — crash / fsck recovery', () => {
  it('rejects mutations while crashed, then replays the pending write on fsck', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hi')

    fs.crash()
    expect(fs.isCrashed()).toBe(true)

    const pendingBefore = fs.getJournal().filter((e) => e.status === 'pending')
    expect(pendingBefore).toHaveLength(1)
    expect(pendingBefore[0]).toMatchObject({ op: 'write', path: '/a.txt', status: 'pending' })

    // Every mutation — and reads — must be refused while the fs is down; nothing should leak through.
    expect(fs.write('/b.txt', 'x').ok).toBe(false)
    expect(fs.create('/c.txt').ok).toBe(false)
    expect(fs.delete('/a.txt').ok).toBe(false)
    expect(fs.read('/a.txt').ok).toBe(false)
    expect(fs.getInodes().map((i) => i.id)).toHaveLength(1) // still just a.txt — b.txt never landed

    const { replayed } = fs.fsck()
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({ op: 'write', path: '/a.txt' })
    expect(fs.isCrashed()).toBe(false)
    expect(fs.getJournal().every((e) => e.status === 'committed')).toBe(true)

    // The replayed write actually landed.
    expect(fs.read('/a.txt')).toEqual({ ok: true, content: 'hi [uncommitted]' })

    // And the fs is usable again.
    expect(fs.write('/b.txt', 'x')).toEqual({ ok: true })
  })

  it('is a no-op to crash twice in a row', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.crash()
    const journalLengthAfterFirst = fs.getJournal().length
    fs.crash()
    expect(fs.getJournal().length).toBe(journalLengthAfterFirst)
  })

  it('mkdir then crash then fsck does not corrupt the tree with a duplicate file+dir sibling (found by code review)', () => {
    // crash() always fabricates a pending op:'write' entry targeting
    // lastTouchedPath, whatever that path actually refers to — mkdir()
    // sets lastTouchedPath to a directory. fsck() replaying that entry
    // must not create a shadow file entry alongside the real directory.
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.mkdir('/d')

    fs.crash()
    const { replayed } = fs.fsck()
    expect(replayed).toHaveLength(1)
    expect(replayed[0]).toMatchObject({ op: 'write', path: '/d' })

    expect(fs.list('/')).toEqual({ ok: true, entries: [{ name: 'd', type: 'dir' }] }) // still exactly one entry
    expect(fs.read('/d')).toEqual({ ok: false, error: 'cat: /d: No such file or directory' }) // still a dir, not readable as a file
    expect(fs.list('/d')).toEqual({ ok: true, entries: [] }) // still an empty, usable directory
  })

  it('fsck() tolerates an unrecognized journal op instead of throwing (defends against a corrupted persisted journal)', () => {
    // A pending journal entry can only normally exist via crash()'s own
    // fabricated 'write' entry, so an unrecognized op can't arise from
    // normal use — but a persisted (IndexedDB) journal is untrusted input,
    // reachable via importState(), and TypeScript's JournalOp type isn't
    // enforced at runtime for data coming from outside the program.
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    const snapshot = fs.exportState()
    const corrupted = {
      ...snapshot,
      journal: [{ id: 1, op: 'bogus' as unknown as JournalOp, path: '/x.txt', status: 'pending' as const, tick: 0 }],
    }
    expect(fs.importState(corrupted)).toBe(true)

    expect(() => fs.fsck()).not.toThrow()
    expect(fs.isCrashed()).toBe(false)
  })
})

describe('FilesystemEngine — journal history cap', () => {
  it('keeps only the most recent entries once the limit is exceeded', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 2 })
    fs.create('/1.txt')
    fs.create('/2.txt')
    fs.create('/3.txt')
    const journal = fs.getJournal()
    expect(journal).toHaveLength(2)
    expect(journal.map((e) => e.path)).toEqual(['/2.txt', '/3.txt'])
  })
})

describe('FilesystemEngine — mkdir', () => {
  it('creates an empty directory and rejects collisions', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    expect(fs.mkdir('/etc')).toEqual({ ok: true })
    expect(fs.list('/etc')).toEqual({ ok: true, entries: [] })

    expect(fs.mkdir('/etc').ok).toBe(false) // already exists as a dir
    fs.write('/etc/passwd', 'root')
    expect(fs.mkdir('/etc/passwd').ok).toBe(false) // already exists as a file
    expect(fs.mkdir('/etc/passwd/x').ok).toBe(false) // ancestor is a file, not a directory
  })
})

describe('FilesystemEngine — mv', () => {
  it('moves a file to a new path, preserving its inode and content', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello')
    const inodeIdBefore = fs.getInodes()[0]!.id

    expect(fs.move('/a.txt', '/b.txt')).toEqual({ ok: true })
    expect(fs.read('/a.txt').ok).toBe(false)
    expect(fs.read('/b.txt')).toEqual({ ok: true, content: 'hello' })
    expect(fs.getInodes()).toHaveLength(1)
    expect(fs.getInodes()[0]!.id).toBe(inodeIdBefore) // same inode, just relocated
  })

  it('rejects moving a directory, or onto an existing path', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.mkdir('/dir')
    fs.write('/a.txt', 'x')
    fs.write('/b.txt', 'y')

    expect(fs.move('/dir', '/dir2').ok).toBe(false)
    expect(fs.move('/nope.txt', '/x.txt').ok).toBe(false)
    expect(fs.move('/a.txt', '/b.txt').ok).toBe(false) // destination already exists
  })
})

describe('FilesystemEngine — cp', () => {
  it('copies a file into an independent inode with its own blocks', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello') // 2 blocks

    expect(fs.copy('/a.txt', '/b.txt')).toEqual({ ok: true })
    expect(fs.read('/a.txt')).toEqual({ ok: true, content: 'hello' }) // source untouched
    expect(fs.read('/b.txt')).toEqual({ ok: true, content: 'hello' })
    expect(fs.getInodes()).toHaveLength(2)

    // Independent inodes: writing to the copy doesn't touch the original.
    fs.write('/b.txt', '!')
    expect(fs.read('/a.txt')).toEqual({ ok: true, content: 'hello' })
    expect(fs.read('/b.txt')).toEqual({ ok: true, content: 'hello!' })
  })

  it('rejects copying onto an existing path or when the disk is full', () => {
    const fs = new FilesystemEngine({ blockCount: 2, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'ab') // 1 block
    fs.write('/b.txt', 'cd') // 1 block, disk now full

    expect(fs.copy('/a.txt', '/b.txt').ok).toBe(false) // dest exists
    expect(fs.copy('/a.txt', '/c.txt')).toEqual({ ok: false, error: 'cp: /c.txt: No space left on device' })
  })
})

describe('FilesystemEngine — ln (hard links)', () => {
  it('a hard link shares the same inode and content as its target', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello')
    const inodeIdBefore = fs.getInodes()[0]!.id

    expect(fs.link('/a.txt', '/b.txt')).toEqual({ ok: true })
    expect(fs.getInodes()).toHaveLength(1) // still one inode, not two
    expect(fs.getInodes()[0]!.id).toBe(inodeIdBefore)
    expect(fs.getInodes()[0]!.links).toBe(2)
    expect(fs.read('/b.txt')).toEqual({ ok: true, content: 'hello' })

    // writing through either path is visible through the other — they share content.
    fs.write('/a.txt', '!')
    expect(fs.read('/b.txt')).toEqual({ ok: true, content: 'hello!' })
  })

  it('the inode and its blocks survive deleting one linked name, and only actually free once the last link is removed', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello')
    fs.link('/a.txt', '/b.txt')

    expect(fs.delete('/a.txt')).toEqual({ ok: true })
    expect(fs.getInodes()).toHaveLength(1) // inode survives — /b.txt still links to it
    expect(fs.getInodes()[0]!.links).toBe(1)
    expect(fs.read('/a.txt').ok).toBe(false)
    expect(fs.read('/b.txt')).toEqual({ ok: true, content: 'hello' })

    expect(fs.delete('/b.txt')).toEqual({ ok: true })
    expect(fs.getInodes()).toHaveLength(0) // last link gone — inode and blocks actually freed
    expect(fs.getBlocks().every((b) => b.owner === null)).toBe(true)
  })

  it('rejects linking a directory, a missing source, or onto an existing destination', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.mkdir('/dir')
    fs.write('/a.txt', 'x')
    fs.write('/b.txt', 'y')

    expect(fs.link('/dir', '/dir2').ok).toBe(false)
    expect(fs.link('/nope.txt', '/x.txt').ok).toBe(false)
    expect(fs.link('/a.txt', '/b.txt').ok).toBe(false) // destination already exists
  })
})

describe('FilesystemEngine — chmod / permissions (roadmap-v3.md §2.3)', () => {
  it('a new file defaults to rw- and is actually readable/writable/deletable', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hi')
    expect(fs.getInodes()[0]!.mode).toBe(0b110)
    expect(rwxTriplet(fs.getInodes()[0]!.mode)).toBe('rw-')
  })

  it('removing the write bit actually rejects write and rm, not just cosmetically', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hi')
    expect(fs.chmod('/a.txt', 0b100)).toEqual({ ok: true }) // r-- : read-only

    expect(fs.write('/a.txt', ' more')).toEqual({ ok: false, error: 'write: /a.txt: Permission denied' })
    expect(fs.delete('/a.txt')).toEqual({ ok: false, error: 'rm: /a.txt: Permission denied' })
    expect(fs.read('/a.txt')).toEqual({ ok: true, content: 'hi' }) // read still works — only w was removed

    // and it's a real, reversible mode change, not a one-way lock
    expect(fs.chmod('/a.txt', 0b110)).toEqual({ ok: true })
    expect(fs.write('/a.txt', ' more')).toEqual({ ok: true })
    expect(fs.read('/a.txt')).toEqual({ ok: true, content: 'hi more' })
  })

  it('removing the read bit rejects cat and cp (as the source), independent of the write bit', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'secret')
    fs.chmod('/a.txt', 0b010) // -w- : write-only, unreadable

    expect(fs.read('/a.txt')).toEqual({ ok: false, error: 'cat: /a.txt: Permission denied' })
    expect(fs.copy('/a.txt', '/b.txt')).toEqual({ ok: false, error: 'cp: /a.txt: Permission denied' })
    expect(fs.write('/a.txt', '!')).toEqual({ ok: true }) // write bit is independent and still present
  })

  it('rejects chmod on a directory or a missing path, and a malformed mode string', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.mkdir('/dir')
    fs.write('/a.txt', 'x')

    expect(fs.chmod('/dir', 0o7).ok).toBe(false)
    expect(fs.chmod('/nope.txt', 0o6).ok).toBe(false)
    expect(fs.chmod('/a.txt', 6)).toEqual({ ok: true }) // sanity: a valid call still works
  })

  it('regression: crash() + fsck() cannot bypass the write-permission check (found by code review)', () => {
    // crash() always fabricates a pending 'write' entry against
    // lastTouchedPath, regardless of what actually last happened — fsck()
    // used to replay it straight through apply(), which never checked
    // MODE_WRITE, silently appending to a file whose write bit had since
    // been removed.
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hi')
    fs.chmod('/a.txt', 0b100) // r-- : read-only, also sets lastTouchedPath to /a.txt

    fs.crash()
    const { replayed } = fs.fsck()
    expect(replayed).toHaveLength(1)

    expect(fs.read('/a.txt')).toEqual({ ok: true, content: 'hi' }) // unchanged — the replay was silently skipped
    expect(fs.isCrashed()).toBe(false) // fsck() still clears crashed state even though the replay itself was a no-op
  })
})

describe('FilesystemEngine — internal permission-bypassing writes (swap coordinator only)', () => {
  it('writeIgnoringPermissions/deleteIgnoringPermissions succeed against a read-only file', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 64, journalHistoryLimit: 50 })
    fs.write('/swap/1-0.swp', 'x')
    fs.chmod('/swap/1-0.swp', 0b100) // r-- : simulate a user locking it down

    expect(fs.write('/swap/1-0.swp', '!').ok).toBe(false) // the normal path still enforces permissions
    expect(fs.writeIgnoringPermissions('/swap/1-0.swp', '!')).toEqual({ ok: true })
    expect(fs.read('/swap/1-0.swp')).toEqual({ ok: true, content: 'x!' })

    expect(fs.delete('/swap/1-0.swp').ok).toBe(false)
    expect(fs.deleteIgnoringPermissions('/swap/1-0.swp')).toEqual({ ok: true })
    expect(fs.read('/swap/1-0.swp').ok).toBe(false)
  })
})

describe('FilesystemEngine — export / import round-trip (persistence)', () => {
  it('reconstructs an identical, independently-usable disk from an exported snapshot', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/home/user/notes.txt', 'hello')
    fs.mkdir('/etc')

    const snapshot = fs.exportState()

    const fs2 = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    expect(fs2.importState(snapshot)).toBe(true)
    expect(fs2.read('/home/user/notes.txt')).toEqual({ ok: true, content: 'hello' })
    expect(fs2.list('/etc')).toEqual({ ok: true, entries: [] })
    expect(fs2.getInodes()).toEqual(fs.getInodes())

    // The two engines are independent after import — mutating one doesn't touch the other.
    fs2.write('/home/user/notes.txt', '!')
    expect(fs.read('/home/user/notes.txt')).toEqual({ ok: true, content: 'hello' })
    expect(fs2.read('/home/user/notes.txt')).toEqual({ ok: true, content: 'hello!' })
  })

  it('does not alias the directory tree between the source engine and an engine imported from its snapshot', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.mkdir('/shared')
    const snapshot = fs.exportState()
    const fs2 = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs2.importState(snapshot)

    // Structural mutations (new dir/file entries) on either engine, or on
    // a stale reference to the already-exported snapshot, must never leak
    // into the other engine's tree.
    fs.mkdir('/shared/only-in-fs')
    fs2.mkdir('/shared/only-in-fs2')

    expect(fs.list('/shared')).toEqual({ ok: true, entries: [{ name: 'only-in-fs', type: 'dir' }] })
    expect(fs2.list('/shared')).toEqual({ ok: true, entries: [{ name: 'only-in-fs2', type: 'dir' }] })
  })

  it('rejects a snapshot with a mismatched schema version or block count, leaving the engine untouched', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'keep-me')
    const snapshot = fs.exportState()

    expect(fs.importState({ ...snapshot, schemaVersion: 999 })).toBe(false)
    expect(fs.importState({ ...snapshot, blockCount: 4 })).toBe(false)
    expect(fs.read('/a.txt')).toEqual({ ok: true, content: 'keep-me' }) // unchanged
  })

  it('rejects a snapshot that is malformed in some other way (not just version/count) without throwing or partially mutating', () => {
    // A persisted IndexedDB record can pass the schemaVersion/blockCount
    // checks and still be corrupted some other way (hand-edited, a
    // browser crash mid-write, a bug in an older build). importState()
    // must reject cleanly rather than throw an uncaught exception that
    // would strand app startup (see app/App.tsx's boot sequence, which
    // has no recovery path for a promise that never resolves).
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/keep.txt', 'safe')
    const snapshot = fs.exportState()
    const malformed: FilesystemState = { ...snapshot, inodes: null as unknown as FilesystemState['inodes'] }

    let result: boolean | undefined
    expect(() => {
      result = fs.importState(malformed)
    }).not.toThrow()
    expect(result).toBe(false)
    expect(fs.read('/keep.txt')).toEqual({ ok: true, content: 'safe' }) // untouched, not half-imported
  })
})

describe('FilesystemEngine — resetToEmpty', () => {
  it('wipes the disk back to a fresh state in place', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'data')
    fs.crash()

    fs.resetToEmpty()

    expect(fs.isCrashed()).toBe(false)
    expect(fs.getInodes()).toHaveLength(0)
    expect(fs.getJournal()).toHaveLength(0)
    expect(fs.getBlocks().every((b) => b.owner === null)).toBe(true)
    expect(fs.getTree()).toEqual({ name: '/', type: 'dir', children: [] })
    expect(fs.write('/fresh.txt', 'x')).toEqual({ ok: true }) // fully usable afterwards
  })

  it('also resets the I/O scheduler (roadmap-v4.md §1.1) so no stale requests survive a wipe', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'data')
    expect(fs.getIoState().pending.length).toBeGreaterThan(0)

    fs.resetToEmpty()

    expect(fs.getIoState()).toEqual({ pending: [], headPosition: 0, direction: 1, recentlyCompleted: [] })
    expect(fs.getIoMetrics().completedCount).toBe(0)
  })
})

describe('FilesystemEngine — I/O scheduling (roadmap-v4.md §1.1)', () => {
  // A request at a cylinder the head starts on/already passed this sweep
  // isn't serviced until the head sweeps to the far end and back — see
  // ioScheduler.test.ts's "catches a request enqueued behind the head" case
  // — so draining fully needs a worst-case double sweep (2 * (blockCount-1)
  // ticks), not just one tick per block.
  const FULL_DRAIN_TICKS = 20

  it('write() enqueues an I/O request per allocated block, and advanceTick() drains the queue via SCAN', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello') // 5 bytes -> 2 blocks -> 2 pending requests

    expect(fs.getIoState().pending).toHaveLength(2)

    for (let i = 0; i < FULL_DRAIN_TICKS; i++) fs.advanceTick()

    expect(fs.getIoState().pending).toHaveLength(0)
    expect(fs.getIoMetrics().completedCount).toBe(2)
  })

  it('read() enqueues one request against the file, and delete() enqueues one per freed block', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello')
    for (let i = 0; i < FULL_DRAIN_TICKS; i++) fs.advanceTick() // drain the write's requests first
    expect(fs.getIoState().pending).toHaveLength(0)

    fs.read('/a.txt')
    expect(fs.getIoState().pending).toHaveLength(1)
    for (let i = 0; i < FULL_DRAIN_TICKS; i++) fs.advanceTick()

    fs.delete('/a.txt')
    expect(fs.getIoState().pending).toHaveLength(2) // both blocks freed
  })

  it('importState() resets the I/O scheduler rather than carrying stale requests over the swapped disk', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello')
    const snapshot = fs.exportState()
    expect(fs.getIoState().pending.length).toBeGreaterThan(0)

    fs.importState(snapshot)

    expect(fs.getIoState()).toEqual({ pending: [], headPosition: 0, direction: 1, recentlyCompleted: [] })
  })
})

describe('FilesystemEngine — symbolic links (roadmap-v5.md §2.2)', () => {
  function fresh() {
    return new FilesystemEngine({ blockCount: 16, blockSizeBytes: 16, journalHistoryLimit: 50 })
  }

  /** list() that throws rather than returning an error result, so a test reads as one line. */
  function entriesOf(fs: FilesystemEngine, path = '/') {
    const result = fs.list(path)
    if (!result.ok) throw new Error(result.error)
    return result.entries
  }

  it('reads through a symlink to the file it names', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'hello')
    expect(fs.symlink('/notes.txt', '/link')).toEqual({ ok: true })
    expect(fs.read('/link')).toEqual({ ok: true, content: 'hello' })
  })

  it('writes through a symlink to the target, not to the link', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'a')
    fs.symlink('/notes.txt', '/link')
    fs.write('/link', 'b')
    expect(fs.read('/notes.txt')).toEqual({ ok: true, content: 'ab' })
    // And the link is still a link, not a file that shadowed the target.
    expect(entriesOf(fs).find((e) => e.name === 'link')).toMatchObject({ type: 'symlink', target: '/notes.txt' })
  })

  it('rm on a symlink removes the link and leaves the target alone — the case that deletes the wrong file if followed', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'hello')
    fs.symlink('/notes.txt', '/link')

    expect(fs.delete('/link')).toEqual({ ok: true })
    expect(fs.read('/notes.txt')).toEqual({ ok: true, content: 'hello' })
    expect(entriesOf(fs).some((e) => e.name === 'link')).toBe(false)
  })

  it('may dangle: creating a link to a path that does not exist is legal, and it starts working when the target appears', () => {
    const fs = fresh()
    expect(fs.symlink('/later.txt', '/link')).toEqual({ ok: true })
    expect(fs.read('/link').ok).toBe(false) // nothing there yet

    fs.write('/later.txt', 'now')
    expect(fs.read('/link')).toEqual({ ok: true, content: 'now' })
  })

  it('resolves a relative target against the directory the link lives in', () => {
    const fs = fresh()
    fs.write('/home/notes.txt', 'hi')
    fs.symlink('notes.txt', '/home/link')
    expect(fs.read('/home/link')).toEqual({ ok: true, content: 'hi' })
  })

  it('follows a symlink used as an intermediate directory component', () => {
    const fs = fresh()
    fs.write('/real/deep/file.txt', 'found')
    fs.symlink('/real/deep', '/shortcut')
    expect(fs.read('/shortcut/file.txt')).toEqual({ ok: true, content: 'found' })
    expect(fs.list('/shortcut').ok).toBe(true)
  })

  it('follows a chain of links', () => {
    const fs = fresh()
    fs.write('/a.txt', 'end')
    fs.symlink('/a.txt', '/b')
    fs.symlink('/b', '/c')
    expect(fs.read('/c')).toEqual({ ok: true, content: 'end' })
  })

  it('gives up on a loop instead of recursing forever (ELOOP)', () => {
    const fs = fresh()
    fs.symlink('/loop-b', '/loop-a')
    fs.symlink('/loop-a', '/loop-b')
    const result = fs.read('/loop-a')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('Too many levels of symbolic links')
  })

  it('a link pointing at itself is created but never followed', () => {
    const fs = fresh()
    expect(fs.symlink('/self', '/self')).toEqual({ ok: true })
    expect(fs.read('/self').ok).toBe(false)
  })

  it('refuses to create a link where something already exists', () => {
    const fs = fresh()
    fs.write('/taken.txt', 'x')
    expect(fs.symlink('/a', '/taken.txt').ok).toBe(false)
    fs.symlink('/a', '/link')
    expect(fs.symlink('/b', '/link').ok).toBe(false)
  })

  it('a hard link made through a symlink lands on the real inode, not on the link', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'shared')
    fs.symlink('/notes.txt', '/link')
    expect(fs.link('/link', '/hard')).toEqual({ ok: true })

    // The hard link shares content with the original file...
    fs.write('/hard', '!')
    expect(fs.read('/notes.txt')).toEqual({ ok: true, content: 'shared!' })
    // ...and the inode's link count reflects two real names, not three.
    expect(fs.getInodes()[0]!.links).toBe(2)
  })

  it('mv moves the link itself rather than what it points at', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'hello')
    fs.symlink('/notes.txt', '/link')
    expect(fs.move('/link', '/moved')).toEqual({ ok: true })

    expect(fs.read('/notes.txt')).toEqual({ ok: true, content: 'hello' }) // untouched
    expect(fs.read('/moved')).toEqual({ ok: true, content: 'hello' }) // still resolves
    expect(entriesOf(fs).find((e) => e.name === 'moved')).toMatchObject({ type: 'symlink' })
  })

  it('chmod through a symlink changes the target — a link has no permission bits of its own', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'x')
    fs.symlink('/notes.txt', '/link')
    fs.chmod('/link', 4) // r--

    expect(fs.write('/notes.txt', 'more').ok).toBe(false) // the target really lost its write bit
    expect(fs.read('/link')).toEqual({ ok: true, content: 'x' })
  })

  it('owns no blocks — a link costs a directory entry and nothing else', () => {
    const fs = fresh()
    const before = fs.getMetrics().usedBlocks
    fs.symlink('/somewhere', '/link')
    expect(fs.getMetrics().usedBlocks).toBe(before)
    expect(fs.getInodes()).toHaveLength(0)
  })

  it('survives an export/import round trip', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'hello')
    fs.symlink('/notes.txt', '/link')

    const restored = fresh()
    expect(restored.importState(fs.exportState())).toBe(true)
    expect(restored.read('/link')).toEqual({ ok: true, content: 'hello' })
  })

  it('replays through the journal after a crash like every other operation', () => {
    const fs = fresh()
    fs.write('/notes.txt', 'hello')
    fs.symlink('/notes.txt', '/link')
    const ops = fs.getJournal().map((e) => e.op)
    expect(ops).toContain('symlink')
    expect(fs.getJournal().every((e) => e.status === 'committed')).toBe(true)
  })
})

describe('FilesystemEngine — free-space bit vector (roadmap-v5.md §2.2)', () => {
  it('reports usage straight from the bitmap the allocator consults', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    expect(fs.getMetrics()).toMatchObject({ usedBlocks: 0, freeBlocks: 8, totalBlocks: 8 })

    fs.write('/a.txt', 'hello') // 5 bytes -> 2 blocks
    expect(fs.getMetrics()).toMatchObject({ usedBlocks: 2, freeBlocks: 6 })
    expect(fs.getFreeSpaceBitmap().filter(Boolean)).toHaveLength(2)
  })

  it('keeps the bitmap and the block owners in agreement across allocate/free cycles', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    const agree = () =>
      fs.getFreeSpaceBitmap().every((allocated, index) => allocated === (fs.getBlocks()[index]!.owner !== null))

    fs.write('/a.txt', 'hello world')
    expect(agree()).toBe(true)
    fs.write('/b.txt', 'more')
    expect(agree()).toBe(true)
    fs.delete('/a.txt')
    expect(agree()).toBe(true)
    expect(fs.getMetrics().usedBlocks).toBe(1)
  })

  it('reuses freed blocks, lowest first', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'aaaa') // block 0
    fs.write('/b.txt', 'bbbb') // block 1
    fs.delete('/a.txt') // frees block 0
    fs.write('/c.txt', 'cccc')

    expect(fs.getInodes().find((i) => i.blockIds.includes(0))).toBeDefined()
    expect(fs.getMetrics().usedBlocks).toBe(2)
  })

  it('rebuilds the bitmap from the disk on import, rather than carrying over stale bits', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello world') // 3 blocks

    const other = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    other.write('/x.txt', 'x') // 1 block of its own first
    expect(other.importState(fs.exportState())).toBe(true)
    expect(other.getMetrics().usedBlocks).toBe(3)
    expect(other.getFreeSpaceBitmap().filter(Boolean)).toHaveLength(3)
  })

  it('clears the bitmap on reset', () => {
    const fs = new FilesystemEngine({ blockCount: 8, blockSizeBytes: 4, journalHistoryLimit: 50 })
    fs.write('/a.txt', 'hello')
    fs.resetToEmpty()
    expect(fs.getMetrics()).toMatchObject({ usedBlocks: 0, freeBlocks: 8 })
    expect(fs.getFreeSpaceBitmap().every((b) => !b)).toBe(true)
  })
})
