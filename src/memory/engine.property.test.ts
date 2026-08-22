import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MemoryEngine } from './engine'

// roadmap.md §2.4 — this is exactly the property that would have caught
// the kernel-frame eviction bug immediately, by hand-tracing far more
// access sequences than any example-based test practically could.

describe('MemoryEngine — property: Clock never evicts a kernel-reserved frame', () => {
  it('holds for arbitrary frame counts, kernel reservations, and access sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }), // kernel frames reserved
        fc.integer({ min: 1, max: 12 }), // frames left over for real processes
        fc.array(fc.record({ page: fc.nat({ max: 9 }), isWrite: fc.boolean() }), { maxLength: 200 }),
        (kernelFrameCount, spareFrameCount, accesses) => {
          const engine = new MemoryEngine({ frameCount: kernelFrameCount + spareFrameCount, contiguousSizeMb: 100 })
          engine.reserveKernelFrames(kernelFrameCount)
          engine.allocateProcess(1, 10) // pages 0..9, matches fc.nat({max: 9})

          for (const a of accesses) engine.access(1, a.page, a.isWrite)

          const frames = engine.getFrames()
          for (let i = 0; i < kernelFrameCount; i++) {
            expect(frames[i]).toMatchObject({ owner: { pid: 0, page: 0 } })
          }
        },
      ),
    )
  })
})

describe('MemoryEngine — property: frame ownership is always exclusive and consistent with the page table', () => {
  it('every owned frame points back to a page table entry that points back to that exact frame', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.record({ page: fc.nat({ max: 7 }), isWrite: fc.boolean() }), { maxLength: 150 }),
        (frameCount, accesses) => {
          const engine = new MemoryEngine({ frameCount, contiguousSizeMb: 100 })
          engine.allocateProcess(1, 8) // pages 0..7, matches fc.nat({max: 7})
          for (const a of accesses) engine.access(1, a.page, a.isWrite)

          const table = engine.getPageTable(1)!
          for (const frame of engine.getFrames()) {
            if (!frame.owner) continue
            const entry = table[frame.owner.page]
            expect(entry?.valid).toBe(true)
            expect(entry?.frame).toBe(frame.index)
            expect(entry?.swapped).toBe(false) // resident and swapped are mutually exclusive
          }
        },
      ),
    )
  })
})

// roadmap-v5.md §1.3 — copy-on-write turns "one frame, one owner" into
// "one frame, several mappings", which is exactly the kind of invariant
// that quietly stops holding under an access sequence nobody wrote a
// example for. The dangerous failure is silent: a stale mapping left
// pointing at a frame that now belongs to somebody else is one process
// reading another's memory.
describe('MemoryEngine — property: after fork, every mapping of every frame is real and current', () => {
  it('holds for arbitrary frame counts and interleaved parent/child access sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 6 }), // accesses by the parent before forking
        fc.array(fc.record({ pid: fc.constantFrom(1, 2), page: fc.nat({ max: 5 }), isWrite: fc.boolean() }), {
          maxLength: 150,
        }),
        (frameCount, warmup, accesses) => {
          const engine = new MemoryEngine({ frameCount, contiguousSizeMb: 100 })
          engine.allocateProcess(1, 6) // pages 0..5, matches fc.nat({max: 5})
          for (let i = 0; i < warmup; i++) engine.access(1, i % 6)
          engine.forkAddressSpace(1, 2)

          for (const a of accesses) engine.access(a.pid, a.page, a.isWrite)

          for (const frame of engine.getFrames()) {
            const mappings = [...(frame.owner ? [frame.owner] : []), ...frame.shares]
            // A free frame carries no leftover sharers.
            if (!frame.owner) expect(frame.shares).toHaveLength(0)

            for (const mapping of mappings) {
              const entry = engine.getPageTable(mapping.pid)?.[mapping.page]
              // Every mapping is live: resident, pointing at this exact
              // frame, and not simultaneously claimed to be on disk.
              expect(entry?.valid).toBe(true)
              expect(entry?.frame).toBe(frame.index)
              expect(entry?.swapped).toBe(false)
            }
            // A frame with more than one mapping must have every one of
            // them marked copy-on-write; a frame with exactly one must
            // have none — an unshared page has nothing to protect against,
            // and a shared page marked writable would let one process's
            // write land in another's address space.
            for (const mapping of mappings) {
              const entry = engine.getPageTable(mapping.pid)?.[mapping.page]
              expect(entry?.cow).toBe(mappings.length > 1)
            }
          }

          // No page table ever points at a frame that disowned it.
          for (const pid of [1, 2]) {
            for (const entry of engine.getPageTable(pid) ?? []) {
              if (!entry.valid || entry.frame === null) continue
              const frame = engine.getFrames()[entry.frame]!
              const mapped =
                (frame.owner?.pid === pid && frame.owner.page === entry.page) ||
                frame.shares.some((m) => m.pid === pid && m.page === entry.page)
              expect(mapped).toBe(true)
            }
          }
        },
      ),
    )
  })
})
