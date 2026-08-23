import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SchedulerEngine, createProcess, resetPidCounter } from './engine'

const MAX_TICKS = 5000

describe('SchedulerEngine — property: CPU burst accounting always matches the declared bursts', () => {
  it('totalBurstTicks == sum of CPU-position burst entries, for ANY bursts array (with or without I/O)', () => {
    const burstsArb = fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 5 })
    const processSpecArb = fc.record({
      kind: fc.constantFrom<'cpu-bound' | 'interactive'>('cpu-bound', 'interactive'),
      bursts: burstsArb,
      spawnDelay: fc.integer({ min: 0, max: 6 }),
    })

    fc.assert(
      fc.property(fc.array(processSpecArb, { minLength: 1, maxLength: 5 }), (specs) => {
        resetPidCounter()
        const engine = new SchedulerEngine()

        const spawnOrder = [...specs].sort((a, b) => a.spawnDelay - b.spawnDelay)
        let tick = 0
        for (const spec of spawnOrder) {
          while (tick < spec.spawnDelay) {
            engine.tick()
            tick++
          }
          engine.spawn(createProcess('p', spec.kind, spec.bursts))
        }

        for (let i = 0; i < MAX_TICKS && engine.getProcesses().some((p) => p.state !== 'TERMINATED'); i++) {
          engine.tick()
        }

        for (const p of engine.getProcesses()) {
          expect(p.state).toBe('TERMINATED')
          const cpuTicks = p.bursts.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0)
          expect(p.totalBurstTicks).toBe(cpuTicks)
        }
      }),
    )
  })
})

describe('SchedulerEngine — property: waiting + burst == turnaround, for I/O-free workloads', () => {
  it('holds for arbitrary counts, burst lengths, and spawn timings of pure-CPU-bound processes', () => {
    const processSpecArb = fc.record({
      burst: fc.integer({ min: 1, max: 20 }),
      spawnDelay: fc.integer({ min: 0, max: 6 }),
    })

    fc.assert(
      fc.property(fc.array(processSpecArb, { minLength: 1, maxLength: 6 }), (specs) => {
        resetPidCounter()
        const engine = new SchedulerEngine()

        const spawnOrder = [...specs].sort((a, b) => a.spawnDelay - b.spawnDelay)
        let tick = 0
        for (const spec of spawnOrder) {
          while (tick < spec.spawnDelay) {
            engine.tick()
            tick++
          }
          engine.spawn(createProcess('p', 'cpu-bound', [spec.burst]))
        }

        for (let i = 0; i < MAX_TICKS && engine.getProcesses().some((p) => p.state !== 'TERMINATED'); i++) {
          engine.tick()
        }

        for (const p of engine.getProcesses()) {
          expect(p.state).toBe('TERMINATED')
          expect(p.totalWaitingTicks + p.totalBurstTicks).toBe(p.finishTick! - p.arrivalTick)
        }
      }),
    )
  })
})
