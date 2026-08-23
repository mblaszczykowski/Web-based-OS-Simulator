import { describe, expect, it } from 'vitest'
import { PIPE_CAPACITY, PipeEngine } from './pipe'

describe('PipeEngine — anonymous pipes as kernel objects', () => {
  it('moves one item per write and reports the reader as the endpoint to wake', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)

    expect(pipes.stepEndpoint(1)).toEqual({ kind: 'transferred', wakeCounterpart: 2 })
    const [pipe] = pipes.getPipes()
    expect(pipe!.buffer).toHaveLength(1)
    expect(pipe!.writtenTotal).toBe(1)
  })

  it('blocks the writer on a full pipe and only lets it through once the reader drains a slot', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    for (let i = 0; i < PIPE_CAPACITY; i++) {
      expect(pipes.stepEndpoint(1).kind).toBe('transferred')
    }
    expect(pipes.getPipes()[0]!.buffer).toHaveLength(PIPE_CAPACITY)
    expect(pipes.stepEndpoint(1)).toEqual({ kind: 'block' })

    expect(pipes.stepEndpoint(2)).toEqual({ kind: 'transferred', wakeCounterpart: 1 })
    expect(pipes.stepEndpoint(1).kind).toBe('transferred')
  })

  it('blocks the reader on an empty pipe and names the writer as the one to wake', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    expect(pipes.stepEndpoint(2)).toEqual({ kind: 'block' })

    pipes.stepEndpoint(1)
    expect(pipes.stepEndpoint(2)).toEqual({ kind: 'transferred', wakeCounterpart: 1 })
  })

  it('reads out in FIFO order — a pipe is a stream, not a pool', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    pipes.stepEndpoint(1)
    pipes.stepEndpoint(1)
    const [before] = pipes.getPipes()
    const [first, second] = before!.buffer

    pipes.stepEndpoint(2)
    expect(pipes.getPipes()[0]!.buffer).toEqual([second])
    expect(first).toBeLessThan(second!)
  })

  it('a reader on an empty pipe whose writer has closed gets EOF, not a block', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    expect(pipes.closeEndpoint(1)).toEqual([2])
    expect(pipes.stepEndpoint(2)).toEqual({ kind: 'eof' })
  })

  it('a reader drains what is still buffered before it sees EOF', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    pipes.stepEndpoint(1)
    pipes.stepEndpoint(1)
    pipes.closeEndpoint(1)

    expect(pipes.stepEndpoint(2).kind).toBe('transferred')
    expect(pipes.stepEndpoint(2).kind).toBe('transferred')
    expect(pipes.stepEndpoint(2)).toEqual({ kind: 'eof' })
  })

  it('a writer whose reader has gone gets a broken pipe rather than filling a buffer nobody will read', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    expect(pipes.closeEndpoint(2)).toEqual([1])
    expect(pipes.stepEndpoint(1)).toEqual({ kind: 'broken' })
  })

  it('drops a pipe once both ends are closed, instead of accumulating dead channels', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    pipes.closeEndpoint(1)
    expect(pipes.getPipes()).toHaveLength(1)
    pipes.closeEndpoint(2)
    expect(pipes.getPipes()).toHaveLength(0)
  })

  it('closing an end twice is harmless and wakes nobody the second time', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    expect(pipes.closeEndpoint(1)).toEqual([2])
    expect(pipes.closeEndpoint(1)).toEqual([])
  })

  it('regression: a half-closed pipe reports the dead end once, not once per tick', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    pipes.stepEndpoint(1)
    pipes.closeEndpoint(2)

    for (let i = 0; i < 50; i++) expect(pipes.stepEndpoint(1)).toEqual({ kind: 'broken' })

    const log = pipes.getLog()
    expect(log.filter((e) => e.text.includes('SIGPIPE'))).toHaveLength(1)
    expect(log.some((e) => e.text.includes('created'))).toBe(true)
    expect(log.some((e) => e.text.includes('wrote'))).toBe(true)
  })

  it('regression: the same holds for a reader repeatedly hitting end of stream', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    pipes.closeEndpoint(1)
    for (let i = 0; i < 50; i++) expect(pipes.stepEndpoint(2)).toEqual({ kind: 'eof' })
    expect(pipes.getLog().filter((e) => e.text.includes('end of stream'))).toHaveLength(1)
  })

  it('a pid that holds no pipe does nothing at all', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    expect(pipes.stepEndpoint(99)).toEqual({ kind: 'none' })
  })

  it('keeps several pipes independent', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    pipes.create(3, 4)
    pipes.stepEndpoint(1)

    const [first, second] = pipes.getPipes()
    expect(first!.buffer).toHaveLength(1)
    expect(second!.buffer).toHaveLength(0)
    expect(pipes.getMetrics().openPipes).toBe(2)
  })

  it('getPipes() hands back a copy — the caller cannot mutate the live buffer', () => {
    const pipes = new PipeEngine()
    pipes.create(1, 2)
    pipes.stepEndpoint(1)
    const snapshot = pipes.getPipes()[0]!
    snapshot.buffer.push(999)
    expect(pipes.getPipes()[0]!.buffer).toHaveLength(1)
  })
})
