import { describe, expect, it } from 'vitest'
import { FIRST_USER_FD, FdTable } from './fdTable'

describe('FdTable — per-process open descriptors (roadmap-v5.md §2.2)', () => {
  it('assigns the lowest free descriptor at or above 3, per process', () => {
    const table = new FdTable()
    expect(table.open(1, 'file', '/a')).toBe(FIRST_USER_FD)
    expect(table.open(1, 'file', '/b')).toBe(FIRST_USER_FD + 1)
    // Numbering is per process, not global — pid 2 starts at 3 too.
    expect(table.open(2, 'file', '/c')).toBe(FIRST_USER_FD)
  })

  it('reuses a closed descriptor rather than climbing forever', () => {
    // This is the observable difference from a monotonic counter: a shell
    // that opens and closes a file per command shows fd 3 every time, the
    // way a real one does.
    const table = new FdTable()
    const fd = table.open(1, 'file', '/a')
    table.close(1, fd)
    expect(table.open(1, 'file', '/b')).toBe(fd)
  })

  it('fills a hole left in the middle', () => {
    const table = new FdTable()
    table.open(1, 'file', '/a') // 3
    const middle = table.open(1, 'file', '/b') // 4
    table.open(1, 'file', '/c') // 5
    table.close(1, middle)
    expect(table.open(1, 'file', '/d')).toBe(middle)
  })

  it('refuses to close a descriptor this process does not hold', () => {
    const table = new FdTable()
    table.open(1, 'file', '/a')
    expect(table.close(2, FIRST_USER_FD)).toBe(false) // belongs to pid 1
    expect(table.close(1, 99)).toBe(false)
    expect(table.forPid(1)).toHaveLength(1)
  })

  it('releases everything a process held when it exits', () => {
    const table = new FdTable()
    table.open(1, 'pipe-write', 'pipe:[1]')
    table.open(1, 'file', '/a')
    table.open(2, 'pipe-read', 'pipe:[1]')

    table.closeAll(1)
    expect(table.forPid(1)).toEqual([])
    expect(table.forPid(2)).toHaveLength(1) // the other end is untouched
  })

  it('lists descriptors in a stable order — by pid, then by fd', () => {
    const table = new FdTable()
    table.open(2, 'file', '/b')
    table.open(1, 'file', '/a')
    table.open(1, 'pipe-read', 'pipe:[1]')
    expect(table.all().map((d) => [d.pid, d.fd])).toEqual([
      [1, 3],
      [1, 4],
      [2, 3],
    ])
  })
})
