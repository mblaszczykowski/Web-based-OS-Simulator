import { describe, expect, it } from 'vitest'
import { MemoryEngine } from './engine'

describe('MemoryEngine — Clock (Second-Chance) replacement', () => {
  it('matches a hand-traced reference string on a 3-frame arena', () => {
    // Reference string 0,1,2,0,3 against 3 frames — the textbook
    // second-chance trace: the three cold faults fill every frame, the
    // hit on page 0 sets its reference bit, and the fault on page 3 has
    // to sweep past every bit (clearing each) before landing back on
    // frame 0 — the only frame whose bit was already cleared.
    const engine = new MemoryEngine({ frameCount: 3, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 5) // pages 0..4, all invalid to start

    expect(engine.access(1, 0)).toEqual({ fault: true, victimFrame: null })
    expect(engine.access(1, 1)).toEqual({ fault: true, victimFrame: null })
    expect(engine.access(1, 2)).toEqual({ fault: true, victimFrame: null })
    expect(engine.access(1, 0)).toEqual({ fault: false, victimFrame: null }) // hit, refreshes its ref bit

    const result = engine.access(1, 3)
    expect(result.fault).toBe(true)
    expect(result.victimFrame).toBe(0) // page 0 evicted, not 1 or 2

    const table = engine.getPageTable(1)!
    expect(table[0]).toMatchObject({ valid: false, frame: null })
    expect(table[1]).toMatchObject({ valid: true, frame: 1 })
    expect(table[2]).toMatchObject({ valid: true, frame: 2 })
    expect(table[3]).toMatchObject({ valid: true, frame: 0 })

    const metrics = engine.getMetrics()
    expect(metrics.accesses).toBe(5)
    expect(metrics.pageFaults).toBe(4)
    expect(metrics.hitRatio).toBeCloseTo(0.2)
  })

  it('fills every free frame before it ever evicts anything', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 4)
    for (let page = 0; page < 4; page++) {
      const result = engine.access(1, page)
      expect(result.victimFrame).toBeNull() // plenty of free frames, never an eviction
    }
    expect(engine.getFrames().every((f) => f.owner !== null)).toBe(true)
  })
})

describe('MemoryEngine — kernel-reserved frames', () => {
  it('are never evicted by the Clock sweep, even after many wraparounds', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.reserveKernelFrames(1) // frame 0 is permanently "OS" — nothing ever re-references it
    engine.allocateProcess(1, 10) // far more pages than the 3 frames actually available to it

    for (let i = 0; i < 40; i++) {
      engine.access(1, i % 10) // enough faults to sweep the clock hand around several times
    }

    expect(engine.getFrames()[0]).toMatchObject({ owner: { pid: 0, page: 0 } })
    expect(engine.getFrames().slice(1).every((f) => f.owner === null || f.owner.pid === 1)).toBe(true)
  })
})

describe('MemoryEngine — freeProcess', () => {
  it('releases every frame the process held and drops its page table', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 3)
    engine.access(1, 0)
    engine.access(1, 1)

    const freed = engine.freeProcess(1)
    expect(freed.sort()).toEqual([0, 1])
    expect(engine.getFrames().every((f) => f.owner === null)).toBe(true)
    expect(engine.getPageTable(1)).toBeUndefined()
  })
})

describe('MemoryEngine — First-Fit contiguous allocation', () => {
  it('places and later coalesces blocks exactly like a hand-traced first-fit run', () => {
    const engine = new MemoryEngine({ frameCount: 8, contiguousSizeMb: 100 })

    engine.allocateProcess(1, 2) // size = max(10, 2*10) = 20
    engine.allocateProcess(2, 3) // size = 30
    engine.allocateProcess(3, 1) // size = 10

    expect(engine.getContiguousBlocks()).toEqual([
      { id: expect.any(String), start: 0, size: 20, owner: 1 },
      { id: expect.any(String), start: 20, size: 30, owner: 2 },
      { id: expect.any(String), start: 50, size: 10, owner: 3 },
      { id: expect.any(String), start: 60, size: 40, owner: null },
    ])
    expect(engine.getMetrics().externalFragmentation).toBeCloseTo(0) // one contiguous free run

    engine.freeProcess(2) // punches a hole between pid 1 and pid 3 — not adjacent to the tail yet
    const midFrag = engine.getMetrics().externalFragmentation
    expect(midFrag).toBeGreaterThan(0) // two disjoint free blocks (30 and 40) now exist

    engine.freeProcess(3) // frees the block between the two existing free runs — should coalesce all three
    expect(engine.getContiguousBlocks()).toEqual([
      { id: expect.any(String), start: 0, size: 20, owner: 1 },
      { id: expect.any(String), start: 20, size: 80, owner: null },
    ])
    expect(engine.getMetrics().externalFragmentation).toBeCloseTo(0) // back to one free run
  })
})
