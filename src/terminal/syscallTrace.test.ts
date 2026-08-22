import { describe, expect, it } from 'vitest'
import { syscallTraceFor } from './syscallTrace'

describe('syscallTraceFor', () => {
  it('run: reports one fork()/execve() pair for a plain successful run', () => {
    expect(syscallTraceFor('run compiler', true, '/')).toEqual(['fork() = <pid>', 'execve("/bin/compiler", [...], [...]) = 0'])
  })

  it('run: reports no syscalls for a plain run that failed', () => {
    expect(syscallTraceFor('run compiler', false, '/')).toEqual([])
  })

  it('run --threads=<n>: reports n forks for a valid, successful thread spawn', () => {
    expect(syscallTraceFor('run --threads=3 worker', true, '/')).toEqual([
      'fork() = <pid> (x3)',
      'execve("/bin/worker", [...], [...]) = 0 (x3)',
    ])
  })

  it('run --threads=<n>: reports no syscalls when the count is out of range — commands.ts never called spawnThreads', () => {
    // Found by code review: this used to unconditionally report a
    // fabricated successful fork()/execve() trace for every --threads=
    // invocation, never checking whether commands.ts actually accepted it.
    expect(syscallTraceFor('run --threads=99 worker', false, '/')).toEqual([])
  })

  it('run --threads=<n>: reports no syscalls when the count is not an integer', () => {
    expect(syscallTraceFor('run --threads=abc worker', false, '/')).toEqual([])
  })
})
