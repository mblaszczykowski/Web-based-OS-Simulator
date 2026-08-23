import { describe, expect, it } from 'vitest'
import { IoScheduler } from './ioScheduler'

describe('IoScheduler — SCAN disk-head scheduling', () => {
  it('services a request exactly when the head sweeps over its cylinder', () => {
    const io = new IoScheduler(8)
    io.enqueue(3, 'write', 0)

    io.step(1)
    io.step(2)
    expect(io.getMetrics().completedCount).toBe(0)
    expect(io.getState().headPosition).toBe(2)

    io.step(3)
    expect(io.getMetrics().completedCount).toBe(1)
    expect(io.getState().pending).toHaveLength(0)
    expect(io.getState().recentlyCompleted[0]).toMatchObject({ blockIndex: 3, kind: 'write' })
  })

  it('catches a request enqueued behind the head only after reversing at the far boundary', () => {
    const io = new IoScheduler(5)
    io.enqueue(4, 'write', 0)
    io.step(1)
    io.enqueue(1, 'write', 1)
    io.step(2)
    io.step(3)
    io.step(4)
    expect(io.getMetrics().completedCount).toBe(1)
    expect(io.getState().pending).toHaveLength(1)

    io.step(5)
    expect(io.getState().direction).toBe(-1)
    io.step(6)
    io.step(7)
    expect(io.getMetrics().completedCount).toBe(2)
    expect(io.getState().pending).toHaveLength(0)
  })

  it('reverses direction at both boundaries in a single sweep', () => {
    const io = new IoScheduler(4)
    io.enqueue(3, 'write', 0)
    io.enqueue(0, 'write', 0)

    io.step(1)
    io.step(2)
    io.step(3)
    expect(io.getMetrics().completedCount).toBe(1)
    expect(io.getState().headPosition).toBe(3)

    io.step(4)
    expect(io.getState().direction).toBe(-1)
    expect(io.getState().headPosition).toBe(2)

    io.step(5)
    io.step(6)
    expect(io.getState().headPosition).toBe(0)
    expect(io.getMetrics().completedCount).toBe(2)
  })

  it('an idle disk parks — no head movement or accumulated seek distance with nothing pending', () => {
    const io = new IoScheduler(8)
    io.step(1)
    io.step(2)
    const state = io.getState()
    expect(state.headPosition).toBe(0)
    expect(io.getMetrics().totalSeekDistance).toBe(0)
  })

  it('accumulates total/average seek distance and average wait ticks across completed requests', () => {
    const io = new IoScheduler(8)
    io.enqueue(2, 'write', 0)
    io.enqueue(5, 'write', 0)
    for (let t = 1; t <= 5; t++) io.step(t)

    const m = io.getMetrics()
    expect(m.completedCount).toBe(2)
    expect(m.totalSeekDistance).toBe(5)
    expect(m.avgSeekDistance).toBe(2.5)
    expect(m.avgWaitTicks).toBeCloseTo(3.5)
  })

  it('ignores an out-of-range enqueue rather than scheduling something unservicable', () => {
    const io = new IoScheduler(4)
    io.enqueue(-1, 'write', 0)
    io.enqueue(4, 'write', 0)
    expect(io.getState().pending).toHaveLength(0)
  })

  it('services a request immediately on a 1-cylinder disk instead of walking onto a nonexistent cylinder', () => {
    const io = new IoScheduler(1)
    io.enqueue(0, 'write', 0)
    io.step(1)
    expect(io.getMetrics().completedCount).toBe(1)
    expect(io.getState().headPosition).toBe(0)
    expect(io.getMetrics().totalSeekDistance).toBe(0)
  })

  it('reset() clears the queue, history, head position, and metrics', () => {
    const io = new IoScheduler(8)
    io.enqueue(3, 'write', 0)
    for (let t = 1; t <= 4; t++) io.step(t)
    expect(io.getMetrics().completedCount).toBeGreaterThan(0)

    io.reset()
    expect(io.getState()).toEqual({ pending: [], headPosition: 0, direction: 1, recentlyCompleted: [] })
    expect(io.getMetrics().completedCount).toBe(0)
    expect(io.getMetrics().totalSeekDistance).toBe(0)
  })
})

describe('IoScheduler — blocking requests and multi-cylinder seeks', () => {
  it('carries the waiting pid through to the completion, so the caller knows who to wake', () => {
    const io = new IoScheduler(8)
    expect(io.enqueue(2, 'read', 0, 42)).toBe(true)
    io.step(1)
    expect(io.step(2)).toMatchObject([{ blockIndex: 2, waiterPid: 42 }])
  })

  it('reports nothing for the filesystem’s own bookkeeping I/O, which nobody is blocked on', () => {
    const io = new IoScheduler(8)
    io.enqueue(1, 'write', 0)
    expect(io.step(1)[0]).toMatchObject({ blockIndex: 1, waiterPid: undefined })
  })

  it('crosses seekCylindersPerTick cylinders per tick, servicing everything it passes over', () => {
    const io = new IoScheduler(16, 4)
    io.enqueue(1, 'read', 0)
    io.enqueue(3, 'read', 0)
    io.enqueue(6, 'read', 0)

    const first = io.step(1)
    expect(first.map((r) => r.blockIndex)).toEqual([1, 3])
    expect(io.getState().headPosition).toBe(4)

    const second = io.step(2)
    expect(second.map((r) => r.blockIndex)).toEqual([6])
    expect(io.getState().headPosition).toBe(6)
    expect(io.getMetrics().totalSeekDistance).toBe(6)
  })

  it('parks mid-tick as soon as the queue empties instead of coasting out the rest of the seek', () => {
    const io = new IoScheduler(16, 4)
    io.enqueue(1, 'read', 0)
    io.step(1)
    expect(io.getState().headPosition).toBe(1)
    expect(io.getMetrics().totalSeekDistance).toBe(1)
  })

  it('can turn around mid-tick when the sweep reaches an end', () => {
    const io = new IoScheduler(4, 4)
    io.enqueue(0, 'read', 0)
    io.step(1)
    expect(io.getState().direction).toBe(-1)
    expect(io.getState().headPosition).toBe(2)
    const rest = io.step(2)
    expect(rest.map((r) => r.blockIndex)).toEqual([0])
  })

  it('reset() hands back the pids left blocked on a discarded request', () => {
    const io = new IoScheduler(8)
    io.enqueue(5, 'read', 0, 7)
    io.enqueue(6, 'write', 0, 9)
    io.enqueue(7, 'write', 0)
    expect(io.reset().sort()).toEqual([7, 9])
    expect(io.reset()).toEqual([])
  })

  it('reports its seek rate in the metrics so the UI can label the head speed honestly', () => {
    expect(new IoScheduler(8).getMetrics().seekCylindersPerTick).toBe(1)
    expect(new IoScheduler(8, 4).getMetrics().seekCylindersPerTick).toBe(4)
  })
})
