import { describe, expect, it } from 'vitest'
import { BankerEngine } from './banker'

describe('BankerEngine — initial scenario is safe (textbook reference)', () => {
  it('finds the book\'s own safe sequence <P1, P3, P4, P0, P2>', () => {
    const banker = new BankerEngine()
    const { safe, sequence } = banker.checkCurrentSafety()
    expect(safe).toBe(true)
    expect(sequence).toEqual([1, 3, 4, 0, 2])
  })

  it('derives Need = Max - Allocation correctly for every process', () => {
    const banker = new BankerEngine()
    expect(banker.getNeed()).toEqual([
      [7, 4, 3],
      [1, 2, 2],
      [6, 0, 0],
      [0, 1, 1],
      [4, 3, 1],
    ])
  })
})

describe('BankerEngine — request() (textbook reference requests)', () => {
  it('grants P1 requesting (1,0,2): stays safe, same sequence as before', () => {
    const banker = new BankerEngine()
    const result = banker.request(1, [1, 0, 2])
    expect(result).toEqual({ ok: true, safeSequence: [1, 3, 4, 0, 2] })
    expect(banker.getAvailable()).toEqual([2, 3, 0])
    expect(banker.getAllocation()[1]).toEqual([3, 0, 2])
    expect(banker.getNeed()[1]).toEqual([0, 2, 0])
  })

  it('after P1s grant (available now [2,3,0]), denies P4 requesting (3,3,0): exceeds what is currently available', () => {
    const banker = new BankerEngine()
    banker.request(1, [1, 0, 2])
    const result = banker.request(4, [3, 3, 0])
    expect(result).toEqual({ ok: false, reason: 'insufficient-available' })
    expect(banker.getAvailable()).toEqual([2, 3, 0])
  })

  it('after P1s grant, denies P0 requesting (0,2,0): available covers it, but granting would be unsafe', () => {
    const banker = new BankerEngine()
    banker.request(1, [1, 0, 2])
    const result = banker.request(0, [0, 2, 0])
    expect(result).toEqual({ ok: false, reason: 'unsafe' })
    expect(banker.getAvailable()).toEqual([2, 3, 0])
    expect(banker.getAllocation()[0]).toEqual([0, 1, 0])
  })

  it('denies a request that exceeds the process\'s own declared need, without even checking availability', () => {
    const banker = new BankerEngine()
    const result = banker.request(3, [5, 0, 0])
    expect(result).toEqual({ ok: false, reason: 'exceeds-need' })
    expect(banker.getAvailable()).toEqual([3, 3, 2])
  })
})

describe('BankerEngine — sequential requests compound correctly', () => {
  it('P1s request lands, then a second request from another process is judged against the NEW state', () => {
    const banker = new BankerEngine()
    expect(banker.request(1, [1, 0, 2]).ok).toBe(true)

    const second = banker.request(2, [2, 0, 0])
    expect(second).toEqual({ ok: true, safeSequence: [1, 3, 4, 2, 0] })
    expect(banker.getAvailable()).toEqual([0, 3, 0])
  })
})

describe('BankerEngine — reset()', () => {
  it('restores the exact textbook initial state after mutation', () => {
    const banker = new BankerEngine()
    banker.request(1, [1, 0, 2])
    banker.reset()

    expect(banker.getAvailable()).toEqual([3, 3, 2])
    expect(banker.getAllocation()).toEqual([
      [0, 1, 0],
      [2, 0, 0],
      [3, 0, 2],
      [2, 1, 1],
      [0, 0, 2],
    ])
    expect(banker.getLog()).toEqual([])
  })
})

describe('BankerEngine — input validation', () => {
  it('throws on an out-of-range pid or a malformed request vector, rather than silently corrupting state', () => {
    const banker = new BankerEngine()
    expect(() => banker.request(-1, [0, 0, 0])).toThrow()
    expect(() => banker.request(5, [0, 0, 0])).toThrow()
    expect(() => banker.request(0, [0, 0])).toThrow()
  })
})
