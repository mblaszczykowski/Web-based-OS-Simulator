import { describe, expect, it } from 'vitest'
import { NetworkEngine } from './engine'

describe('NetworkEngine — ping', () => {
  it('launches a staggered burst that all eventually reply, exactly once each', () => {
    const engine = new NetworkEngine()
    engine.ping('example.com', 3)
    expect(engine.getStats().pingsSent).toBe(3)
    expect(engine.getStats().pingsReceived).toBe(0)

    for (let i = 0; i < 60 && engine.getPackets().length > 0; i++) engine.tick()

    expect(engine.getPackets()).toHaveLength(0) // every packet arrived and was cleaned up
    expect(engine.getStats().pingsReceived).toBe(3)
  })

  it('never has more in-flight packets than a full ping burst could produce', () => {
    const engine = new NetworkEngine()
    engine.ping('server', 4)
    for (let i = 0; i < 30; i++) {
      engine.tick()
      expect(engine.getPackets().length).toBeLessThanOrEqual(4)
    }
  })
})

describe('NetworkEngine — curl', () => {
  it('sends one request and receives exactly one response', () => {
    const engine = new NetworkEngine()
    engine.curl('api.example.com')
    expect(engine.getStats().requestsSent).toBe(1)

    for (let i = 0; i < 30 && engine.getPackets().length > 0; i++) engine.tick()

    expect(engine.getStats().responsesReceived).toBe(1)
    expect(engine.getPackets()).toHaveLength(0)
  })
})

describe('NetworkEngine — log', () => {
  it('records both the request and the eventual reply', () => {
    const engine = new NetworkEngine()
    engine.ping('host', 1)
    for (let i = 0; i < 30 && engine.getPackets().length > 0; i++) engine.tick()

    const texts = engine.getLog().map((l) => l.text)
    expect(texts.some((t) => t.startsWith('PING host'))).toBe(true)
    expect(texts.some((t) => t.includes('echo reply'))).toBe(true)
    expect(texts.some((t) => t.includes('reply from host'))).toBe(true)
  })
})
