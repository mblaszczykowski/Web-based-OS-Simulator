import { describe, expect, it } from 'vitest'
import { DeadlockEngine } from './deadlock'

describe('DeadlockEngine — scripted circular-wait scenario', () => {
  it('walks through acquisition, blocking, and detects the cycle via the wait-for graph', () => {
    const engine = new DeadlockEngine()
    expect(engine.getStep()).toBe('idle')
    expect(engine.hasCycle()).toBe(false)

    engine.advance() // P1 acquires R1
    expect(engine.getStep()).toBe('p1-acquired-r1')
    expect(engine.getHeldBy()).toEqual({ R1: 1, R2: null })

    engine.advance() // P2 acquires R2
    expect(engine.getStep()).toBe('p2-acquired-r2')
    expect(engine.getHeldBy()).toEqual({ R1: 1, R2: 2 })
    expect(engine.hasCycle()).toBe(false) // no one's blocked yet

    engine.advance() // P1 requests R2 -> blocks
    expect(engine.getStep()).toBe('p1-blocked-on-r2')
    expect(engine.getWaitForGraph()).toEqual([{ from: 1, to: 2 }])
    expect(engine.hasCycle()).toBe(false) // one-way wait isn't a cycle yet

    engine.advance() // P2 requests R1 -> blocks -> circular wait -> deadlock detected
    expect(engine.getStep()).toBe('deadlocked')
    expect(engine.hasCycle()).toBe(true)
    const graph = engine.getWaitForGraph()
    expect(graph).toHaveLength(2)
    expect(graph).toEqual(expect.arrayContaining([{ from: 1, to: 2 }, { from: 2, to: 1 }]))
  })

  it('is a no-op to advance() once deadlocked', () => {
    const engine = new DeadlockEngine()
    for (let i = 0; i < 4; i++) engine.advance()
    expect(engine.getStep()).toBe('deadlocked')
    engine.advance()
    engine.advance()
    expect(engine.getStep()).toBe('deadlocked') // still deadlocked, not corrupted by extra advances
  })
})

describe('DeadlockEngine — breaking the deadlock', () => {
  it('killing one actor releases its resource and hands the survivor what it was waiting on', () => {
    const engine = new DeadlockEngine()
    for (let i = 0; i < 4; i++) engine.advance()
    expect(engine.getStep()).toBe('deadlocked')

    engine.breakDeadlock(2) // kill P2
    expect(engine.getStep()).toBe('resolved')
    expect(engine.hasCycle()).toBe(false)
    expect(engine.getHeldBy()).toEqual({ R1: 1, R2: 1 }) // P1 now holds both — R2 handed over
    expect(engine.getWants()).toEqual({ 1: null, 2: null })
  })

  it('is a no-op before a deadlock actually exists', () => {
    const engine = new DeadlockEngine()
    engine.advance() // p1-acquired-r1, not deadlocked
    engine.breakDeadlock(1)
    expect(engine.getStep()).toBe('p1-acquired-r1') // unaffected
  })

  it('reset() clears everything so the scenario can run again from scratch', () => {
    const engine = new DeadlockEngine()
    for (let i = 0; i < 4; i++) engine.advance()
    engine.breakDeadlock(1)

    engine.reset()
    expect(engine.getStep()).toBe('idle')
    expect(engine.getHeldBy()).toEqual({ R1: null, R2: null })
    expect(engine.getWants()).toEqual({ 1: null, 2: null })
  })
})
