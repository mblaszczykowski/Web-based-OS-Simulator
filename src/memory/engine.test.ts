import { describe, expect, it } from 'vitest'
import { MemoryEngine } from './engine'

describe('MemoryEngine — Clock (Second-Chance) replacement', () => {
  it('matches a hand-traced reference string on a 3-frame arena', () => {
    const engine = new MemoryEngine({ frameCount: 3, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 5)

    expect(engine.access(1, 0)).toEqual({ fault: true, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false })
    expect(engine.access(1, 1)).toEqual({ fault: true, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false })
    expect(engine.access(1, 2)).toEqual({ fault: true, victimFrame: null, victims: [], wasSwapped: false, tlbHit: false, cowCopy: false })
    expect(engine.access(1, 0)).toEqual({ fault: false, victimFrame: null, victims: [], wasSwapped: false, tlbHit: true, cowCopy: false })

    const result = engine.access(1, 3)
    expect(result.fault).toBe(true)
    expect(result.victimFrame).toBe(0)
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
      expect(result.victimFrame).toBeNull()
    }
    expect(engine.getFrames().every((f) => f.owner !== null)).toBe(true)
  })
})

describe('MemoryEngine — kernel-reserved frames', () => {
  it('are never evicted by the Clock sweep, even after many wraparounds', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.reserveKernelFrames(1)
    engine.allocateProcess(1, 10)

    for (let i = 0; i < 40; i++) {
      engine.access(1, i % 10)
    }

    expect(engine.getFrames()[0]).toMatchObject({ owner: { pid: 0, page: 0 } })
    expect(engine.getFrames().slice(1).every((f) => f.owner === null || f.owner.pid === 1)).toBe(true)
  })
})

describe('MemoryEngine — dirty (modified) bit', () => {
  it('is set by a write access, cleared on eviction, and unaffected by a plain read', () => {
    const engine = new MemoryEngine({ frameCount: 1, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)

    engine.access(1, 0, true)
    expect(engine.getPageTable(1)![0]).toMatchObject({ valid: true, modified: true })

    engine.access(1, 0, false)
    expect(engine.getPageTable(1)![0]!.modified).toBe(true)

    engine.access(1, 1, false)
    expect(engine.getPageTable(1)![0]).toMatchObject({ valid: false, modified: false })
    expect(engine.getPageTable(1)![1]).toMatchObject({ valid: true, modified: false })
  })
})

describe('MemoryEngine — swap bookkeeping', () => {
  it('marks an evicted page swapped, then reports wasSwapped when it faults back in', () => {
    const engine = new MemoryEngine({ frameCount: 1, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)

    engine.access(1, 0)
    expect(engine.getMetrics().swappedPages).toBe(0)

    const evicting = engine.access(1, 1)
    expect(evicting.victims).toEqual([{ pid: 1, page: 0 }])
    expect(engine.getPageTable(1)![0]!.swapped).toBe(true)
    expect(engine.getMetrics().swappedPages).toBe(1)
    expect(engine.getSwappedPages(1)).toEqual([0])

    const faultingBackIn = engine.access(1, 0)
    expect(faultingBackIn.wasSwapped).toBe(true)
    expect(engine.getPageTable(1)![0]!.swapped).toBe(false)
    expect(engine.getMetrics().swappedPages).toBe(1)
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
    engine.access(1, 1)
    expect(engine.getMetrics().swappedPages).toBe(1)

    engine.freeProcess(1)
    expect(engine.getMetrics().swappedPages).toBe(0)
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

    engine.allocateProcess(1, 2)
    engine.allocateProcess(2, 3)
    engine.allocateProcess(3, 1)

    expect(engine.getContiguousBlocks()).toEqual([
      { id: expect.any(String), start: 0, size: 20, owner: 1 },
      { id: expect.any(String), start: 20, size: 30, owner: 2 },
      { id: expect.any(String), start: 50, size: 10, owner: 3 },
      { id: expect.any(String), start: 60, size: 40, owner: null },
    ])
    expect(engine.getMetrics().externalFragmentation).toBeCloseTo(0)

    engine.freeProcess(2)
    const midFrag = engine.getMetrics().externalFragmentation
    expect(midFrag).toBeGreaterThan(0)

    engine.freeProcess(3)
    expect(engine.getContiguousBlocks()).toEqual([
      { id: expect.any(String), start: 0, size: 20, owner: 1 },
      { id: expect.any(String), start: 20, size: 80, owner: null },
    ])
    expect(engine.getMetrics().externalFragmentation).toBeCloseTo(0)
  })
})

describe('MemoryEngine — TLB', () => {
  it('a repeated access to a still-resident page is a TLB hit; the first touch never is', () => {
    const engine = new MemoryEngine({ frameCount: 4, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 4)

    expect(engine.access(1, 0).tlbHit).toBe(false)
    expect(engine.access(1, 0).tlbHit).toBe(true)
    expect(engine.getMetrics().tlbHitRatio).toBeCloseTo(0.5)
  })

  it('evicts the least-recently-touched entry once the TLB is full — a page-table hit can still be a TLB miss', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 9)

    for (let page = 0; page < 9; page++) engine.access(1, page)
    expect(engine.getTlbEntries()).toHaveLength(8)

    const table = engine.getPageTable(1)!
    expect(table[0]).toMatchObject({ valid: true, frame: expect.any(Number) })
    expect(engine.access(1, 0).tlbHit).toBe(false)
  })

  it('invalidates a page\'s TLB entry when Clock evicts it, so a later re-fault is never misreported as a hit', () => {
    const engine = new MemoryEngine({ frameCount: 1, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)

    engine.access(1, 0)
    engine.access(1, 1)
    const result = engine.access(1, 0)
    expect(result.fault).toBe(true)
    expect(result.tlbHit).toBe(false)
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

describe('MemoryEngine — thrashing indicator', () => {
  it('reports not-thrashing before the sliding window has even filled, regardless of fault rate so far', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 30)

    for (let page = 0; page < 10; page++) engine.access(1, page)
    expect(engine.isThrashing()).toBe(false)
  })

  it('flags thrashing once the recent fault rate crosses the threshold over a full window', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 30)

    for (let page = 0; page < 20; page++) engine.access(1, page)
    expect(engine.getRecentFaultRate()).toBe(1)
    expect(engine.isThrashing()).toBe(true)
  })

  it('stops reporting thrashing once enough recent accesses are hits — it is a sliding window, not sticky', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 30)

    for (let page = 0; page < 20; page++) engine.access(1, page)
    expect(engine.isThrashing()).toBe(true)

    for (let i = 0; i < 20; i++) engine.access(1, 19)
    expect(engine.isThrashing()).toBe(false)
  })
})

describe('MemoryEngine — fork and copy-on-write', () => {
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
    expect(engine.getPageTable(2)![0]!.cow).toBe(true)
  })

  it('the first write copies the frame, and only for the process that wrote', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    parentWithResidentPages(engine, 1, 2)
    engine.forkAddressSpace(1, 2)
    const sharedFrame = engine.getPageTable(1)![0]!.frame
    const usedBefore = engine.getFrames().filter((f) => f.owner !== null).length

    const write = engine.access(2, 0, true)

    expect(write.cowCopy).toBe(true)
    expect(engine.getFrames().filter((f) => f.owner !== null).length).toBe(usedBefore + 1)
    const child = engine.getPageTable(2)![0]!
    expect(child.frame).not.toBe(sharedFrame)
    expect(child.cow).toBe(false)
    expect(child.modified).toBe(true)
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

    engine.access(2, 0, true)
    expect(engine.getPageTable(1)![0]!.cow).toBe(true)
    expect(engine.getPageTable(3)![0]!.cow).toBe(true)

    engine.access(3, 0, true)
    expect(engine.getPageTable(1)![0]!.cow).toBe(false)
  })

  it('evicting a shared frame invalidates every mapping of it, not just the owner’s', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.allocateProcess(1, 2)
    engine.access(1, 0)
    engine.access(1, 1)
    engine.forkAddressSpace(1, 2)
    const sharedFrame = engine.getPageTable(1)![0]!.frame!

    for (let i = 0; i < 6; i++) engine.access(1, i % 2)

    const parentEntry = engine.getPageTable(1)![0]!
    const childEntry = engine.getPageTable(2)![0]!
    if (engine.getFrames()[sharedFrame]!.owner?.pid !== 1) {
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

    engine.freeProcess(1)

    for (const frameIndex of sharedFrames) {
      const frame = engine.getFrames()[frameIndex!]!
      expect(frame.owner).not.toBeNull()
      expect(frame.owner!.pid).toBe(2)
    }
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
    expect(engine.forkAddressSpace(1, 3)).toBe(false)
  })

  it('gives the child a private, non-resident entry for a parent page that is not resident', () => {
    const engine = new MemoryEngine({ frameCount: 10, contiguousSizeMb: 200 })
    engine.allocateProcess(1, 3)
    engine.access(1, 0)
    engine.forkAddressSpace(1, 2)

    const child = engine.getPageTable(2)!
    expect(child[0]!.cow).toBe(true)
    expect(child[1]).toMatchObject({ valid: false, frame: null, cow: false, swapped: false })
    expect(child[2]).toMatchObject({ valid: false, frame: null, cow: false, swapped: false })
  })

  it('terminates instead of spinning when there is no frame it may copy into', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.reserveKernelFrames(1)
    engine.allocateProcess(1, 1)
    engine.access(1, 0)
    engine.forkAddressSpace(1, 2)
    const sharedFrame = engine.getPageTable(1)![0]!.frame!

    const write = engine.access(2, 0, true)

    expect(write.cowCopy).toBe(true)
    expect(engine.getPageTable(2)![0]!.frame).toBe(sharedFrame)
    expect(engine.getPageTable(2)![0]!.cow).toBe(false)
    expect(engine.getPageTable(1)![0]!.valid).toBe(false)
    expect(engine.getPageTable(1)![0]!.swapped).toBe(true)
    expect(write.victims).toEqual([{ pid: 1, page: 0 }])
  })

  it('reports an unservicable fault rather than sweeping forever when every frame is reserved', () => {
    const engine = new MemoryEngine({ frameCount: 2, contiguousSizeMb: 100 })
    engine.reserveKernelFrames(2)
    engine.allocateProcess(1, 1)

    const result = engine.access(1, 0)
    expect(result.fault).toBe(true)
    expect(result.victimFrame).toBeNull()
    expect(engine.getPageTable(1)![0]!.valid).toBe(false)
  })

  it('the copy never lands on the frame it is copying from', () => {
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
