import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SyncEngine, SYNC_BUFFER_CAPACITY } from './engine'

// roadmap.md §2.4 — the example-based tests in engine.test.ts already
// cover one long run each; this generalizes across arbitrary run lengths.

describe('SyncEngine — property: safe mode never violates its invariants, for any run length', () => {
  it('occupancy stays in bounds, mutual exclusion holds, and nothing ever corrupts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600 }), (ticks) => {
        const engine = new SyncEngine(false)
        for (let i = 0; i < ticks; i++) {
          engine.tick()
          const m = engine.getMetrics()
          expect(m.realOccupancy).toBeGreaterThanOrEqual(0)
          expect(m.realOccupancy).toBeLessThanOrEqual(SYNC_BUFFER_CAPACITY)
          expect(m.corruptionEvents).toBe(0)
          expect(engine.getActors().filter((a) => a.state === 'in-critical-section').length).toBeLessThanOrEqual(1)
        }
      }),
    )
  })
})
