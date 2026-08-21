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
