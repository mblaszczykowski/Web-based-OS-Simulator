import type { PipeLogEntry, PipeState } from '../shared/types'

export const PIPE_CAPACITY = 4

const LOG_LIMIT = 40

export type PipeStepOutcome =
  | { kind: 'none' }
  | { kind: 'transferred'; wakeCounterpart: number }
  | { kind: 'block' }
  | { kind: 'eof' }
  | { kind: 'broken' }

interface InternalPipe extends PipeState {
  buffer: number[]
  endNotified: boolean
}

/**
 * Anonymous pipes between real scheduled processes: a bounded buffer where
 * the writer blocks when it fills and the reader when it empties.
 *
 * Decides who *should* block and who should be woken and returns that; the
 * scheduler does the blocking (wired up in app/engines.ts). The shell's `|`
 * is a separate thing — a filter over rendered output, not this.
 */
export class PipeEngine {
  private pipes: InternalPipe[] = []
  private nextId = 1
  private nextItemSeq = 1
  private log: PipeLogEntry[] = []
  private nextLogId = 1

  create(writerPid: number, readerPid: number): PipeState {
    const pipe: InternalPipe = {
      id: this.nextId++,
      writerPid,
      readerPid,
      buffer: [],
      capacity: PIPE_CAPACITY,
      writtenTotal: 0,
      readTotal: 0,
      writerOpen: true,
      readerOpen: true,
      endNotified: false,
    }
    this.pipes.push(pipe)
    this.pushLog(pipe.id, `pipe(${writerPid} → ${readerPid}) created`)
    return pipe
  }

  private pushLog(pipeId: number, text: string, kind: PipeLogEntry['kind'] = 'info'): void {
    this.log.push({ id: this.nextLogId++, pipeId, text, kind })
    if (this.log.length > LOG_LIMIT) this.log.shift()
  }

  private findEndpoint(pid: number): { pipe: InternalPipe; role: 'writer' | 'reader' } | undefined {
    for (const pipe of this.pipes) {
      if (pipe.writerPid === pid && pipe.writerOpen) return { pipe, role: 'writer' }
      if (pipe.readerPid === pid && pipe.readerOpen) return { pipe, role: 'reader' }
    }
    return undefined
  }

  /**
   * One pipe operation by whichever process is on the CPU. An endpoint only
   * touches its pipe while running, which is why a blocked one can't retry
   * and must be woken by the other side.
   */
  stepEndpoint(pid: number): PipeStepOutcome {
    const found = this.findEndpoint(pid)
    if (!found) return { kind: 'none' }
    const { pipe, role } = found

    if (role === 'writer') {
      if (!pipe.readerOpen) {
        if (!pipe.endNotified) {
          pipe.endNotified = true
          this.pushLog(pipe.id, `W${pid}: reader gone — write fails (SIGPIPE)`, 'warning')
        }
        return { kind: 'broken' }
      }
      if (pipe.buffer.length >= pipe.capacity) {
        this.pushLog(pipe.id, `W${pid} blocked — pipe full (${pipe.buffer.length}/${pipe.capacity})`, 'block')
        return { kind: 'block' }
      }
      const item = this.nextItemSeq++
      pipe.buffer.push(item)
      pipe.writtenTotal++
      this.pushLog(pipe.id, `W${pid} wrote #${item} (${pipe.buffer.length}/${pipe.capacity})`)
      return { kind: 'transferred', wakeCounterpart: pipe.readerPid }
    }

    if (pipe.buffer.length === 0) {
      if (!pipe.writerOpen) {
        if (!pipe.endNotified) {
          pipe.endNotified = true
          this.pushLog(pipe.id, `R${pid}: end of stream (writer closed)`)
        }
        return { kind: 'eof' }
      }
      this.pushLog(pipe.id, `R${pid} blocked — pipe empty`, 'block')
      return { kind: 'block' }
    }
    const item = pipe.buffer.shift()!
    pipe.readTotal++
    this.pushLog(pipe.id, `R${pid} read #${item} (${pipe.buffer.length}/${pipe.capacity})`)
    return { kind: 'transferred', wakeCounterpart: pipe.writerPid }
  }

  /**
   * One end's process is gone. Returns the counterpart to wake: a reader
   * parked on an empty pipe whose writer just exited would otherwise wait
   * for data that can never arrive.
   */
  closeEndpoint(pid: number): number[] {
    const wake: number[] = []
    for (const pipe of this.pipes) {
      if (pipe.writerPid === pid && pipe.writerOpen) {
        pipe.writerOpen = false
        this.pushLog(pipe.id, `writer ${pid} closed its end`)
        if (pipe.readerOpen) wake.push(pipe.readerPid)
      }
      if (pipe.readerPid === pid && pipe.readerOpen) {
        pipe.readerOpen = false
        this.pushLog(pipe.id, `reader ${pid} closed its end`)
        if (pipe.writerOpen) wake.push(pipe.writerPid)
      }
    }
    this.pipes = this.pipes.filter((p) => p.writerOpen || p.readerOpen)
    return wake
  }

  getPipes(): PipeState[] {
    return this.pipes.map((p) => ({ ...p, buffer: [...p.buffer] }))
  }

  getLog(): PipeLogEntry[] {
    return this.log
  }

  getMetrics() {
    return {
      openPipes: this.pipes.length,
      writtenTotal: this.pipes.reduce((sum, p) => sum + p.writtenTotal, 0),
      readTotal: this.pipes.reduce((sum, p) => sum + p.readTotal, 0),
    }
  }
}
