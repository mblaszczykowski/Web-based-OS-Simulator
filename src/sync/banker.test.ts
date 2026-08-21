import { describe, expect, it } from 'vitest'
import { BankerEngine } from './banker'

// Every case here is hand-verified against Silberschatz's own worked
// example (the same scenario banker.ts's INITIAL_ALLOCATION/MAX/AVAILABLE
// hard-code) — not just "does the code agree with itself".

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
    // fully rolled back — available is unchanged from right after P1's grant
    expect(banker.getAvailable()).toEqual([2, 3, 0])
  })

  it('after P1s grant, denies P0 requesting (0,2,0): available covers it, but granting would be unsafe', () => {
    const banker = new BankerEngine()
    banker.request(1, [1, 0, 2])
    const result = banker.request(0, [0, 2, 0])
    expect(result).toEqual({ ok: false, reason: 'unsafe' })
    // the tentative grant must be fully rolled back, not left half-applied
    expect(banker.getAvailable()).toEqual([2, 3, 0])
    expect(banker.getAllocation()[0]).toEqual([0, 1, 0])
  })

  it('denies a request that exceeds the process\'s own declared need, without even checking availability', () => {
    const banker = new BankerEngine()
    // P3's need is [0,1,1] — requesting 5 of A exceeds it outright.
    const result = banker.request(3, [5, 0, 0])
    expect(result).toEqual({ ok: false, reason: 'exceeds-need' })
    expect(banker.getAvailable()).toEqual([3, 3, 2])
  })
})

describe('BankerEngine — sequential requests compound correctly', () => {
  it('P1s request lands, then a second request from another process is judged against the NEW state', () => {
    const banker = new BankerEngine()
    expect(banker.request(1, [1, 0, 2]).ok).toBe(true) // available now [2,3,0]

    // P2 requesting 2 of A is judged against the POST-P1-grant available
    // pool ([2,3,0]) and Need — both `request()` calls are independently
    // correct, but this only holds if the second one sees the first's
    // effects rather than the pristine initial state.
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
    expect(() => banker.request(0, [0, 0])).toThrow() // wrong resource count
  })
})
