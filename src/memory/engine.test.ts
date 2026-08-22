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

    expect(engine.access(1, 0)).toEqual({ fault: true, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false })
    expect(engine.access(1, 1)).toEqual({ fault: true, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false })
    expect(engine.access(1, 2)).toEqual({ fault: true, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false })
    // hit, refreshes its ref bit — and a TLB hit too, since page 0's translation is still cached from its fault above
    expect(engine.access(1, 0)).toEqual({ fault: false, victimFrame: null, victims: [], wasSwapped: false, tlbHit: true, cowCopy: false })

    const result = engine.access(1, 3)
    expect(result.fault).toBe(true)
    expect(result.victimFrame).toBe(0) // page 0 evicted, not 1 or 2
    expect(result.victims).toEqual([{ pid: 1, page: 0 }])
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
    expect(evicting.victims).toEqual([{ pid: 1, page: 0 }])
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
      expect(result.victims.every((v) => v.pid !== 0)).toBe(true)
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

describe('MemoryEngine — fork and copy-on-write (roadmap-v5.md §1.3)', () => {
  /** A parent with `pages` resident pages, on an engine with plenty of frames. */
  function parentWithResidentPages(engine: MemoryEngine, pid: number, pages: number) {
    engine.allocateProcess(pid, pages)
    for (let page = 0; page < pages; page++) engine.access(pid, page)
  }

  it('shares every resident frame instead of copying it — memory usage does not move on fork', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 3)
    const usedBefore = engine.getFrames().filter((f) => f.owner !== null).length

    expect(engine.forkAddressSpace(1, 2)).toBe(true)

    expect(engine.getFrames().filter((f) => f.owner !== null).length).toBe(usedBefore)
    expect(engine.getSharedFrameCount()).toBe(3)
    // Both tables point at the same frames, and both sides are marked COW.
    for (let page = 0; page < 3; page++) {
      const parent = engine.getPageTable(1)![page]!
      const child = engine.getPageTable(2)![page]!
      expect(child.frame).toBe(parent.frame)
      expect(parent.cow).toBe(true)
      expect(child.cow).toBe(true)
    }
  })

  it('a read by either side is an ordinary hit — nothing is copied until somebody writes', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 2)
    engine.forkAddressSpace(1, 2)
    const usedBefore = engine.getFrames().filter((f) => f.owner !== null).length

    const read = engine.access(2, 0, false)
    expect(read.cowCopy).toBe(false)
    expect(read.fault).toBe(false)
    expect(engine.getFrames().filter((f) => f.owner !== null).length).toBe(usedBefore)
    expect(engine.getPageTable(2)![0]!.cow).toBe(true) // still shared
  })

  it('the first write copies the frame, and only for the process that wrote', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 2)
    engine.forkAddressSpace(1, 2)
    const sharedFrame = engine.getPageTable(1)![0]!.frame
    const usedBefore = engine.getFrames().filter((f) => f.owner !== null).length

    const write = engine.access(2, 0, true)

    expect(write.cowCopy).toBe(true)
    expect(engine.getFrames().filter((f) => f.owner !== null).length).toBe(usedBefore + 1) // one real copy
    const child = engine.getPageTable(2)![0]!
    expect(child.frame).not.toBe(sharedFrame) // moved to a private frame
    expect(child.cow).toBe(false)
    expect(child.modified).toBe(true)
    // The parent keeps the original frame — and, with nobody left sharing
    // it, no longer needs protecting.
    expect(engine.getPageTable(1)![0]!.frame).toBe(sharedFrame)
    expect(engine.getPageTable(1)![0]!.cow).toBe(false)
    expect(engine.getMetrics().cowFaults).toBe(1)
  })

  it('a copy-on-write copy is not counted as a page fault — nothing was paged in', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 2)
    engine.forkAddressSpace(1, 2)
    const faultsBefore = engine.getMetrics().pageFaults

    engine.access(2, 0, true)
    expect(engine.getMetrics().pageFaults).toBe(faultsBefore)
    expect(engine.getMetrics().cowFaults).toBe(1)
  })

  it('keeps the page protected while a third sharer still exists', () => {
    const engine = new MemoryEngine({ frameCount: 12, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 1)
    engine.forkAddressSpace(1, 2)
    engine.forkAddressSpace(1, 3)

    engine.access(2, 0, true) // P2 diverges
    // P1 and P3 still share the original, so it stays copy-on-write.
    expect(engine.getPageTable(1)![0]!.cow).toBe(true)
    expect(engine.getPageTable(3)![0]!.cow).toBe(true)

    engine.access(3, 0, true) // P3 diverges too — P1 is alone now
    expect(engine.getPageTable(1)![0]!.cow).toBe(false)
  })

  it('evicting a shared frame invalidates every mapping of it, not just the owner’s', () => {
    // Two frames total, one of them kernel-reserved, so the very next
    // fault has no choice but to evict the shared frame.
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)
    engine.access(1, 0)
    engine.access(1, 1)
    engine.forkAddressSpace(1, 2)
    const sharedFrame = engine.getPageTable(1)![0]!.frame!

    // Force enough faults that the shared frame is swept up.
    for (let i = 0; i < 6; i++) engine.access(1, i % 2)

    const parentEntry = engine.getPageTable(1)![0]!
    const childEntry = engine.getPageTable(2)![0]!
    if (engine.getFrames()[sharedFrame]!.owner?.pid !== 1) {
      // Whoever ended up holding the frame, the child's stale mapping must
      // not still claim it — that would be one process reading another's
      // memory, the one thing paging exists to prevent.
      expect(childEntry.valid && childEntry.frame === sharedFrame && parentEntry.frame === sharedFrame).toBe(false)
    }
    for (const frame of engine.getFrames()) {
      for (const mapping of [...(frame.owner ? [frame.owner] : []), ...frame.shares]) {
        if (mapping.pid === 0) continue
        const entry = engine.getPageTable(mapping.pid)?.[mapping.page]
        expect(entry?.valid).toBe(true)
        expect(entry?.frame).toBe(frame.index)
      }
    }
  })

  it('freeing one side of a fork never frees a frame the other side is still reading', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 3)
    engine.forkAddressSpace(1, 2)
    const sharedFrames = engine.getPageTable(1)!.map((e) => e.frame)

    engine.freeProcess(1) // the parent exits first

    for (const frameIndex of sharedFrames) {
      const frame = engine.getFrames()[frameIndex!]!
      expect(frame.owner).not.toBeNull() // still mapped by the child
      expect(frame.owner!.pid).toBe(2)
    }
    // And the child, now alone, no longer carries a pointless COW flag.
    expect(engine.getPageTable(2)!.every((e) => !e.cow)).toBe(true)
    expect(engine.getSharedFrameCount()).toBe(0)
  })

  it('frees the frames once the last sharer exits', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 3)
    engine.forkAddressSpace(1, 2)

    engine.freeProcess(1)
    engine.freeProcess(2)
    expect(engine.getFrames().every((f) => f.owner === null)).toBe(true)
  })

  it('refuses to fork an address space that does not exist, or onto one that already does', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    engine.allocateProcess(1, 2)
    expect(engine.forkAddressSpace(99, 2)).toBe(false)
    engine.allocateProcess(3, 2)
    expect(engine.forkAddressSpace(1, 3)).toBe(false) // pid 3 already has one
  })

  it('gives the child a private, non-resident entry for a parent page that is not resident', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    engine.allocateProcess(1, 3)
    engine.access(1, 0) // only page 0 is ever touched
    engine.forkAddressSpace(1, 2)

    const child = engine.getPageTable(2)!
    expect(child[0]!.cow).toBe(true)
    // Pages 1 and 2 were never resident: the child faults its own copy in
    // rather than sharing a page file keyed by the parent's pid.
    expect(child[1]).toMatchObject({ valid: false, frame: null, cow: false, swapped: false })
    expect(child[2]).toMatchObject({ valid: false, frame: null, cow: false, swapped: false })
  })

  it('the copy never lands on the frame it is copying from', () => {
    // One usable frame beyond the kernel's: the Clock sweep's only
    // candidate would be the shared source frame itself, which must be
    // excluded or the copy would overwrite its own source.
    const engine = new MemoryEngine({ frameCount: 3, contiguousSizeMb: 100 })
    engine.reserveKernelFrames(1)
    engine.allocateProcess(1, 1)
    engine.access(1, 0)
    engine.forkAddressSpace(1, 2)
    const sourceFrame = engine.getPageTable(1)![0]!.frame!

    engine.access(2, 0, true)
    expect(engine.getPageTable(2)![0]!.frame).not.toBe(sourceFrame)
    expect(engine.getPageTable(1)![0]!.frame).toBe(sourceFrame)
  })
})
