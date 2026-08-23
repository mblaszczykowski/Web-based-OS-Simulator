import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { MemoryEngine } from './engine'

describe('MemoryEngine — property: Clock never evicts a kernel-reserved frame', () => {
  it('holds for arbitrary frame counts, kernel reservations, and access sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.record({ page: fc.nat({ max: 9 }), isWrite: fc.boolean() }), { maxLength: 200 }),
        (kernelFrameCount, spareFrameCount, accesses) => {
          const engine = new MemoryEngine({ frameCount: kernelFrameCount + spareFrameCount, contiguousSizeMb: 100 })
          engine.reserveKernelFrames(kernelFrameCount)
          engine.allocateProcess(1, 10)

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
          engine.allocateProcess(1, 8)
          for (const a of accesses) engine.access(1, a.page, a.isWrite)

          const table = engine.getPageTable(1)!
          for (const frame of engine.getFrames()) {
            if (!frame.owner) continue
            const entry = table[frame.owner.page]
            expect(entry?.valid).toBe(true)
            expect(entry?.frame).toBe(frame.index)
            expect(entry?.swapped).toBe(false)
          }
        },
      ),
    )
  })
})

describe('MemoryEngine — property: after fork, every mapping of every frame is real and current', () => {
  it('holds for arbitrary frame counts and interleaved parent/child access sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.record({ pid: fc.constantFrom(1, 2), page: fc.nat({ max: 5 }), isWrite: fc.boolean() }), {
          maxLength: 150,
        }),
        (frameCount, warmup, accesses) => {
          const engine = new MemoryEngine({ frameCount, contiguousSizeMb: 100 })
          engine.allocateProcess(1, 6)
          for (let i = 0; i < warmup; i++) engine.access(1, i % 6)
          engine.forkAddressSpace(1, 2)

          for (const a of accesses) engine.access(a.pid, a.page, a.isWrite)

          for (const frame of engine.getFrames()) {
            const mappings = [...(frame.owner ? [frame.owner] : []), ...frame.shares]
            if (!frame.owner) expect(frame.shares).toHaveLength(0)

            for (const mapping of mappings) {
              const entry = engine.getPageTable(mapping.pid)?.[mapping.page]
              expect(entry?.valid).toBe(true)
              expect(entry?.frame).toBe(frame.index)
              expect(entry?.swapped).toBe(false)
            }
            for (const mapping of mappings) {
              const entry = engine.getPageTable(mapping.pid)?.[mapping.page]
              expect(entry?.cow).toBe(mappings.length > 1)
            }
          }

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
