import { describe, expect, it } from 'vitest'
import { FilesystemEngine } from './engine'

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
