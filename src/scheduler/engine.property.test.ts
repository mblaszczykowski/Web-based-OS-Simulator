import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { SchedulerEngine, createProcess, resetPidCounter } from './engine'

// roadmap.md §2.4 — property-based tests catch classes of bugs a handful
// of hand-picked examples can miss (exactly how the kernel-frame eviction
// bug mentioned there was originally found by hand). fast-check generates
// many random workloads per run and shrinks any failure to a minimal
// reproduction — see the two real bugs this file's first drafts actually
// found, fixed in engine.ts and covered by regression tests in
// engine.test.ts (a malformed-bursts phantom-tick bug) and documented
// below (why the general "waiting + burst == turnaround" formula doesn't
// hold once I/O bursts are involved).

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

// The textbook formula roadmap.md §2.4 suggests — "waiting + burst ==
// turnaround" — only holds when there's no I/O in the mix. With I/O
// bursts, it can UNDER-count turnaround by design: when a process's I/O
// completes on a tick where the CPU is otherwise idle, this scheduler
// dispatches it that same tick rather than wasting a tick first (the
// existing hand-traced "I/O return without demotion" test in
// engine.test.ts asserts exactly this and works out its numbers by hand:
// bursts [3,5,3] sum to 11 declared ticks but finish at tick 10, because
// tick 8 does double duty — it's simultaneously the I/O burst's last tick
// and the next CPU burst's first tick). That's a deliberate design choice
// documented there, not a bug, so this property is restricted to
// I/O-free (single-burst) processes, where it's exact by construction.
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
