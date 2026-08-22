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

    expect(engine.access(1, 0)).toEqual({ fault: true, victimFrame: null, victim: null, wasSwapped: false, tlbHit: false })
    expect(engine.access(1, 1)).toEqual({ fault: true, victimFrame: null, victim: null, wasSwapped: false, tlbHit: false })
    expect(engine.access(1, 2)).toEqual({ fault: true, victimFrame: null, victim: null, wasSwapped: false, tlbHit: false })
    // hit, refreshes its ref bit — and a TLB hit too, since page 0's translation is still cached from its fault above
    expect(engine.access(1, 0)).toEqual({ fault: false, victimFrame: null, victim: null, wasSwapped: false, tlbHit: true })

    const result = engine.access(1, 3)
    expect(result.fault).toBe(true)
    expect(result.victimFrame).toBe(0) // page 0 evicted, not 1 or 2
    expect(result.victim).toEqual({ pid: 1, page: 0 })
    expect(result.wasSwapped).toBe(false)

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

describe('MemoryEngine — dirty (modified) bit', () => {
  it('is set by a write access, cleared on eviction, and unaffected by a plain read', () => {
    const engine = new MemoryEngine({ frameCount: 1, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)

    engine.access(1, 0, true) // write-fault installs page 0, dirty
    expect(engine.getPageTable(1)![0]).toMatchObject({ valid: true, modified: true })

    engine.access(1, 0, false) // a plain read hit must not clear an existing dirty bit
    expect(engine.getPageTable(1)![0]!.modified).toBe(true)

    engine.access(1, 1, false) // only 1 frame -> this evicts page 0
    expect(engine.getPageTable(1)![0]).toMatchObject({ valid: false, modified: false }) // written back, now clean
    expect(engine.getPageTable(1)![1]).toMatchObject({ valid: true, modified: false }) // fresh read-fault, clean
  })
})

describe('MemoryEngine — swap bookkeeping (roadmap.md §2.1)', () => {
  it('marks an evicted page swapped, then reports wasSwapped when it faults back in', () => {
    const engine = new MemoryEngine({ frameCount: 1, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)

    engine.access(1, 0) // installs page 0
    expect(engine.getMetrics().swappedPages).toBe(0)

    const evicting = engine.access(1, 1) // only 1 frame -> evicts page 0
    expect(evicting.victim).toEqual({ pid: 1, page: 0 })
    expect(engine.getPageTable(1)![0]!.swapped).toBe(true)
    expect(engine.getMetrics().swappedPages).toBe(1)
    expect(engine.getSwappedPages(1)).toEqual([0])

    const faultingBackIn = engine.access(1, 0) // evicts page 1 this time, brings page 0 back
    expect(faultingBackIn.wasSwapped).toBe(true)
    expect(engine.getPageTable(1)![0]!.swapped).toBe(false) // resident again, no longer swapped
    expect(engine.getMetrics().swappedPages).toBe(1) // page 1 is now the one swapped out
    expect(engine.getSwappedPages(1)).toEqual([1])
  })

  it('never counts a kernel-reserved frame as a swappable victim', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.reserveKernelFrames(1)
    engine.allocateProcess(1, 5)

    for (let i = 0; i < 5; i++) {
      const result = engine.access(1, i)
      expect(result.victim?.pid).not.toBe(0)
    }
  })

  it('reconciles the swapped counter when a process with swapped-out pages is freed', () => {
    const engine = new MemoryEngine({ frameCount: 1, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)
    engine.access(1, 0)
    engine.access(1, 1) // evicts+swaps page 0
    expect(engine.getMetrics().swappedPages).toBe(1)

    engine.freeProcess(1)
    expect(engine.getMetrics().swappedPages).toBe(0) // no leaked count now that the table is gone
  })
})

describe('MemoryEngine — allocateProcess double-call guard', () => {
  it('throws instead of silently leaking a second contiguous block for the same pid', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)
    expect(() => engine.allocateProcess(1, 2)).toThrow(/already allocated/)
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

describe('MemoryEngine — TLB (roadmap-v4.md §2.2)', () => {
  it('a repeated access to a still-resident page is a TLB hit; the first touch never is', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 4)

    expect(engine.access(1, 0).tlbHit).toBe(false) // cold fault — nothing to have cached yet
    expect(engine.access(1, 0).tlbHit).toBe(true) // still resident, and now cached
    expect(engine.getMetrics().tlbHitRatio).toBeCloseTo(0.5)
  })

  it('evicts the least-recently-touched entry once the TLB is full — a page-table hit can still be a TLB miss', () => {
    // TLB_CAPACITY is 8 (see the module constant); 10 frames is plenty so
    // none of these 9 distinct pages ever gets evicted from the page
    // table itself — only the TLB fills up.
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 9)

    for (let page = 0; page < 9; page++) engine.access(1, page) // 9 cold faults, each inserted into the TLB
    expect(engine.getTlbEntries()).toHaveLength(8) // capacity-bounded — page 0's entry was evicted for page 8's

    const table = engine.getPageTable(1)!
    expect(table[0]).toMatchObject({ valid: true, frame: expect.any(Number) }) // still resident...
    expect(engine.access(1, 0).tlbHit).toBe(false) // ...but the TLB had to re-walk the page table for it
  })

  it('invalidates a page\'s TLB entry when Clock evicts it, so a later re-fault is never misreported as a hit', () => {
    const engine = new MemoryEngine({ frameCount: 1, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)

    engine.access(1, 0) // installs page 0, caches it in the TLB
    engine.access(1, 1) // only 1 frame -> evicts page 0 (and must invalidate its TLB entry)
    const result = engine.access(1, 0) // re-faults page 0 back in
    expect(result.fault).toBe(true)
    expect(result.tlbHit).toBe(false) // never true on a fault — see AccessResult.tlbHit's doc
  })

  it('freeProcess purges every TLB entry belonging to that pid', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)
    engine.access(1, 0)
    engine.access(1, 1)
    expect(engine.getTlbEntries().filter((e) => e.pid === 1)).toHaveLength(2)

    engine.freeProcess(1)
    expect(engine.getTlbEntries().filter((e) => e.pid === 1)).toHaveLength(0)
  })
})

describe('MemoryEngine — thrashing indicator (roadmap-v4.md §2.2)', () => {
  it('reports not-thrashing before the sliding window has even filled, regardless of fault rate so far', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 30)

    for (let page = 0; page < 10; page++) engine.access(1, page) // 10 cold faults in a row — 100% so far
    expect(engine.isThrashing()).toBe(false) // but the window (20) hasn't filled yet
  })

  it('flags thrashing once the recent fault rate crosses the threshold over a full window', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 30)

    for (let page = 0; page < 20; page++) engine.access(1, page) // 20 distinct pages, 2 frames — every access faults
    expect(engine.getRecentFaultRate()).toBe(1)
    expect(engine.isThrashing()).toBe(true)
  })

  it('stops reporting thrashing once enough recent accesses are hits — it is a sliding window, not sticky', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 30)

    for (let page = 0; page < 20; page++) engine.access(1, page)
    expect(engine.isThrashing()).toBe(true)

    // The most recent access installed page 19 into one of the 2 frames;
    // repeatedly re-accessing it is a hit every time, diluting the window.
    for (let i = 0; i < 20; i++) engine.access(1, 19)
    expect(engine.isThrashing()).toBe(false)
  })
})
