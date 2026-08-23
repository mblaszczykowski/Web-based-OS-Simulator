import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { FilesystemEngine } from './engine'

const PATHS = ['/a.txt', '/b.txt', '/c.txt'] as const
const opArb = fc.oneof(
  fc.record({ kind: fc.constant('create' as const), path: fc.constantFrom(...PATHS) }),
  fc.record({ kind: fc.constant('write' as const), path: fc.constantFrom(...PATHS), text: fc.string({ maxLength: 12 }) }),
  fc.record({ kind: fc.constant('delete' as const), path: fc.constantFrom(...PATHS) }),
  fc.record({ kind: fc.constant('mkdir' as const), path: fc.constantFrom(...PATHS) }),
  fc.record({
    kind: fc.constant('move' as const),
    path: fc.constantFrom(...PATHS),
    target: fc.constantFrom(...PATHS),
  }),
  fc.record({
    kind: fc.constant('copy' as const),
    path: fc.constantFrom(...PATHS),
    target: fc.constantFrom(...PATHS),
  }),
  fc.record({
    kind: fc.constant('link' as const),
    path: fc.constantFrom(...PATHS),
    target: fc.constantFrom(...PATHS),
  }),
  fc.record({
    kind: fc.constant('chmod' as const),
    path: fc.constantFrom(...PATHS),
    mode: fc.integer({ min: 0, max: 7 }),
  }),
  fc.record({
    kind: fc.constant('symlink' as const),
    path: fc.constantFrom(...PATHS),
    target: fc.constantFrom(...PATHS),
  }),
)

describe('FilesystemEngine — property: block accounting always reconciles', () => {
  it('used + free blocks always equals total, and both match ground truth, across arbitrary op sequences', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const fs = new FilesystemEngine({ blockCount: 16, blockSizeBytes: 4, journalHistoryLimit: 50 })

        for (const op of ops) {
          if (op.kind === 'create') fs.create(op.path)
          else if (op.kind === 'write') fs.write(op.path, op.text)
          else if (op.kind === 'delete') fs.delete(op.path)
          else if (op.kind === 'mkdir') fs.mkdir(op.path)
          else if (op.kind === 'move') fs.move(op.path, op.target)
          else if (op.kind === 'copy') fs.copy(op.path, op.target)
          else if (op.kind === 'link') fs.link(op.path, op.target)
          else if (op.kind === 'symlink') fs.symlink(op.target, op.path)
          else fs.chmod(op.path, op.mode)

          const m = fs.getMetrics()
          expect(m.usedBlocks + m.freeBlocks).toBe(m.totalBlocks)

          const blocks = fs.getBlocks()
          const actuallyUsed = blocks.filter((b) => b.owner !== null).length
          expect(actuallyUsed).toBe(m.usedBlocks)

          const blocksOwnedByInodes = fs.getInodes().reduce((sum, inode) => sum + inode.blockIds.length, 0)
          expect(blocksOwnedByInodes).toBe(actuallyUsed)

          const usedBlockIndices = blocks.filter((b) => b.owner !== null).map((b) => b.index)
          expect(new Set(usedBlockIndices).size).toBe(usedBlockIndices.length)
        }
      }),
    )
  })
})
