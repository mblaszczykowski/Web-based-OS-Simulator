import { describe, expect, it } from 'vitest'
import { SyncEngine, SYNC_BUFFER_CAPACITY } from './engine'

describe('SyncEngine — safe mode invariants', () => {
  it('never lets buffer occupancy leave [0, capacity], and never corrupts a slot', () => {
    const engine = new SyncEngine(false)
    for (let i = 0; i < 400; i++) {
      engine.tick()
      const m = engine.getMetrics()
      expect(m.realOccupancy).toBeGreaterThanOrEqual(0)
      expect(m.realOccupancy).toBeLessThanOrEqual(SYNC_BUFFER_CAPACITY)
      expect(m.corruptionEvents).toBe(0)
    }
  })

  it('reconciles expected vs. real occupancy once no actor is mid-transaction (holding a reserved slot it hasn\'t committed yet)', () => {
    const engine = new SyncEngine(false)
    for (let i = 0; i < 400; i++) {
      engine.tick()
      const actors = engine.getActors()
      const quiescent = actors.every((a) => a.state !== 'waiting-mutex' && a.state !== 'in-critical-section')
      if (!quiescent) continue
      const m = engine.getMetrics()
      expect(m.realOccupancy).toBe(m.expectedOccupancy)
    }
  })

  it('enforces mutual exclusion — at most one actor is ever inside the critical section at once', () => {
    const engine = new SyncEngine(false)
    for (let i = 0; i < 200; i++) {
      engine.tick()
      const inCs = engine.getActors().filter((a) => a.state === 'in-critical-section')
      expect(inCs.length).toBeLessThanOrEqual(1)
    }
  })

  it('conserves items — every produced item is eventually consumed exactly once', () => {
    const engine = new SyncEngine(false)
    for (let i = 0; i < 500; i++) engine.tick()
    const m = engine.getMetrics()
    expect(m.consumedTotal).toBeLessThanOrEqual(m.producedTotal)
    expect(m.producedTotal - m.consumedTotal).toBe(m.realOccupancy)
  })
})

describe('SyncEngine — unsafe mode demonstrates the race it exists to demonstrate', () => {
  it('produces a corrupted buffer within a handful of ticks once the mutex is bypassed', () => {
    const engine = new SyncEngine(true)
    for (let i = 0; i < 10; i++) engine.tick()
    expect(engine.getMetrics().corruptionEvents).toBeGreaterThan(0)
  })
})
