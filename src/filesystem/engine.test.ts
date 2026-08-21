import { describe, expect, it } from 'vitest'
import { FilesystemEngine, type FilesystemState } from './engine'
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
})
