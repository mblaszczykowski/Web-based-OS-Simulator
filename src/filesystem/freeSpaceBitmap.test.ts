import { describe, expect, it } from 'vitest'
import { FreeSpaceBitmap } from './freeSpaceBitmap'

describe('FreeSpaceBitmap — free-space management as a bit vector (roadmap-v5.md §2.2)', () => {
  it('starts entirely free and tracks claims and releases', () => {
    const bitmap = new FreeSpaceBitmap(8)
    expect(bitmap.freeCount).toBe(8)
    expect(bitmap.used).toBe(0)

    expect(bitmap.claim(3)).toBe(true)
    expect(bitmap.isFree(3)).toBe(false)
    expect(bitmap.freeCount).toBe(7)

    expect(bitmap.release(3)).toBe(true)
    expect(bitmap.isFree(3)).toBe(true)
    expect(bitmap.freeCount).toBe(8)
  })

  it('refuses a double claim or a double release, so the used count can never drift', () => {
    const bitmap = new FreeSpaceBitmap(8)
    bitmap.claim(0)
    expect(bitmap.claim(0)).toBe(false)
    expect(bitmap.used).toBe(1)

    bitmap.release(0)
    expect(bitmap.release(0)).toBe(false)
    expect(bitmap.used).toBe(0)
  })

  it('treats an out-of-range block as neither free nor claimable', () => {
    const bitmap = new FreeSpaceBitmap(8)
    expect(bitmap.isFree(-1)).toBe(false)
    expect(bitmap.isFree(8)).toBe(false)
    expect(bitmap.claim(8)).toBe(false)
    expect(bitmap.release(-1)).toBe(false)
    expect(bitmap.used).toBe(0)
  })

  it('finds the first free block, and the first free one after a starting point', () => {
    const bitmap = new FreeSpaceBitmap(8)
    bitmap.claim(0)
    bitmap.claim(1)
    expect(bitmap.findFirstFree()).toBe(2)
    expect(bitmap.findFirstFree(5)).toBe(5)
  })

  it('reports -1 when the disk is full rather than a bogus block', () => {
    const bitmap = new FreeSpaceBitmap(4)
    for (let i = 0; i < 4; i++) bitmap.claim(i)
    expect(bitmap.findFirstFree()).toBe(-1)
    expect(bitmap.freeCount).toBe(0)
  })

  it('skips an entirely-allocated word instead of testing its 32 blocks one by one', () => {
    // The whole reason a bit vector is the classic representation: a full
    // word is rejected with one comparison. Observable only as the right
    // answer, but this is the case that exercises the skip path.
    const bitmap = new FreeSpaceBitmap(96) // three 32-bit words
    for (let i = 0; i < 64; i++) bitmap.claim(i) // words 0 and 1 completely full
    expect(bitmap.findFirstFree()).toBe(64)
  })

  it('handles a partial trailing word — the bits past the end are not free blocks', () => {
    const bitmap = new FreeSpaceBitmap(40) // 8 blocks into the second word
    for (let i = 0; i < 40; i++) bitmap.claim(i)
    expect(bitmap.findFirstFree()).toBe(-1) // not 40, 41, ... which don't exist
    expect(bitmap.freeCount).toBe(0)
  })

  it('rebuilds from ground truth, discarding whatever it held before', () => {
    const bitmap = new FreeSpaceBitmap(8)
    bitmap.claim(0)
    bitmap.claim(1)
    bitmap.rebuild((block) => block === 5)
    expect(bitmap.used).toBe(1)
    expect(bitmap.isFree(0)).toBe(true)
    expect(bitmap.isFree(5)).toBe(false)
  })

  it('renders one boolean per block for the UI, allocated first', () => {
    const bitmap = new FreeSpaceBitmap(4)
    bitmap.claim(1)
    expect(bitmap.toArray()).toEqual([false, true, false, false])
  })
})
