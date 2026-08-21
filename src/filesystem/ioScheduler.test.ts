import { describe, expect, it } from 'vitest'
import { IoScheduler } from './ioScheduler'

describe('IoScheduler — SCAN disk-head scheduling', () => {
  it('services a request exactly when the head sweeps over its cylinder', () => {
    const io = new IoScheduler(8)
    io.enqueue(3, 'write', 0)

    io.step(1) // head 0 -> 1
    io.step(2) // 1 -> 2
    expect(io.getMetrics().completedCount).toBe(0)
    expect(io.getState().headPosition).toBe(2)

    io.step(3) // 2 -> 3, lands on the request
    expect(io.getMetrics().completedCount).toBe(1)
    expect(io.getState().pending).toHaveLength(0)
    expect(io.getState().recentlyCompleted[0]).toMatchObject({ blockIndex: 3, kind: 'write' })
  })

  it('catches a request enqueued behind the head only after reversing at the far boundary', () => {
    const io = new IoScheduler(5) // cylinders 0..4
    io.enqueue(4, 'write', 0) // keeps the sweep going all the way to the high end
    io.step(1) // 0 -> 1
    io.enqueue(1, 'write', 1) // the head already passed cylinder 1 this sweep — missed, not serviced
    io.step(2) // 1 -> 2
    io.step(3) // 2 -> 3
    io.step(4) // 3 -> 4 (high end, services the request at 4, direction flips to -1 next step)
    expect(io.getMetrics().completedCount).toBe(1)
    expect(io.getState().pending).toHaveLength(1) // the missed request at 1 is still waiting

    io.step(5) // direction flips to -1 (headPosition was at the high end); 4 -> 3
    expect(io.getState().direction).toBe(-1)
    io.step(6) // 3 -> 2
    io.step(7) // 2 -> 1 — now the reversed sweep reaches it
    expect(io.getMetrics().completedCount).toBe(2)
    expect(io.getState().pending).toHaveLength(0)
  })

  it('reverses direction at both boundaries in a single sweep', () => {
    const io = new IoScheduler(4) // cylinders 0..3
    io.enqueue(3, 'write', 0)
    io.enqueue(0, 'write', 0) // sits behind the head at the start — only reachable after the high-end turnaround

    io.step(1) // 0 -> 1
    io.step(2) // 1 -> 2
    io.step(3) // 2 -> 3 (high end; services the request at 3 — direction hasn't flipped yet this step)
    expect(io.getMetrics().completedCount).toBe(1)
    expect(io.getState().headPosition).toBe(3)

    io.step(4) // direction flips to -1 on entry (head was at the high end); 3 -> 2
    expect(io.getState().direction).toBe(-1)
    expect(io.getState().headPosition).toBe(2)

    io.step(5) // 2 -> 1
    io.step(6) // 1 -> 0 (low end; services the request at 0)
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
    for (let t = 1; t <= 5; t++) io.step(t) // head reaches cylinder 5 after 5 steps, passing 2 on the way

    const m = io.getMetrics()
    expect(m.completedCount).toBe(2)
    expect(m.totalSeekDistance).toBe(5) // the head moved 5 cylinders total to service both
    expect(m.avgSeekDistance).toBe(2.5)
    // request at 2 waited 2 ticks (enqueued at 0, serviced at 2), request at 5 waited 5 ticks
    expect(m.avgWaitTicks).toBeCloseTo(3.5)
  })

  it('ignores an out-of-range enqueue rather than scheduling something unservicable', () => {
    const io = new IoScheduler(4)
    io.enqueue(-1, 'write', 0)
    io.enqueue(4, 'write', 0) // cylinderCount is 4, so valid indices are 0..3
    expect(io.getState().pending).toHaveLength(0)
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
