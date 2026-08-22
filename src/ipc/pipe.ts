import type { PipeLogEntry, PipeState } from '../shared/types'

/**
 * Slots in one pipe's buffer. Deliberately small — a real pipe's 64 KiB
 * kernel buffer almost never fills, which would make the interesting half
 * of the mechanism (a writer blocking on a full pipe) invisible. Four
 * slots means both blocking directions happen within a handful of ticks,
 * for the same reason SYNC_BUFFER_CAPACITY is 6 rather than realistic.
 */
export const PIPE_CAPACITY = 4

const LOG_LIMIT = 40

/** What one endpoint's attempt to use the pipe did this tick — see PipeEngine.stepEndpoint(). */
export type PipeStepOutcome =
  /** This pid isn't an endpoint of any open pipe; nothing happened. */
  | { kind: 'none' }
  /** An item moved. `wakeCounterpart` is the pid to release if it was parked on this pipe. */
  | { kind: 'transferred'; wakeCounterpart: number }
  /** The endpoint must block: a full pipe for a writer, an empty one for a reader. */
  | { kind: 'block' }
  /** A reader found the pipe empty and the writer gone — end of stream, nothing left to wait for. */
  | { kind: 'eof' }
  /** A writer found the reader gone. Real Unix raises SIGPIPE; here the write simply fails and the writer runs on. */
  | { kind: 'broken' }

interface InternalPipe extends PipeState {
  buffer: number[]
}

/**
 * Anonymous pipes as real kernel objects — roadmap-v5.md §1.2.
 *
 * The shell's `|` is, and stays, a *shell-level* filter over a command's
 * rendered output (`ls | grep .log`): none of this simulator's terminal
 * commands is a long-running process with a stdout to connect, so there is
 * nothing there for a kernel pipe to sit between. The `pipe` command
 * instead spawns two genuine scheduler processes and connects them, which
 * is where the mechanism actually means something: a bounded buffer, a
 * writer that blocks when it fills, a reader that blocks when it empties,
 * and each one waking the other.
 *
 * This is the bounded-buffer machinery from `sync/engine.ts` pointed at
 * real processes instead of an animated panel. The two stay separate on
 * purpose: SyncEngine demonstrates *how* a semaphore/mutex pair makes the
 * buffer safe (including the unsafe mode that shows what breaks without
 * it), while this models what the buffer is *for* — one process feeding
 * another. Merging them would cost the first its self-contained
 * before/after story.
 *
 * Like every other engine here this is plain, dependency-free TypeScript:
 * it decides who should block and who should wake, and returns that.
 * Actually blocking a process is the scheduler's job, wired up one level
 * above in `app/engines.ts` (ADR-0004).
 */
export class PipeEngine {
  private pipes: InternalPipe[] = []
  private nextId = 1
  private nextItemSeq = 1
  private log: PipeLogEntry[] = []
  private nextLogId = 1

  /**
   * Connects two pids with a fresh pipe. The caller is responsible for the
   * processes themselves already existing — this only models the channel.
   */
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
   * One pipe operation by whichever process is currently on the CPU. A
   * process only touches its pipe while it is actually running — which is
   * the whole reason a blocked endpoint can't retry on its own and has to
   * be woken by the other side.
   */
  stepEndpoint(pid: number): PipeStepOutcome {
    const found = this.findEndpoint(pid)
    if (!found) return { kind: 'none' }
    const { pipe, role } = found

    if (role === 'writer') {
      if (!pipe.readerOpen) {
        this.pushLog(pipe.id, `W${pid}: reader gone — write fails (SIGPIPE)`, 'warning')
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
        this.pushLog(pipe.id, `R${pid}: end of stream (writer closed)`)
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
   * One endpoint's process is gone. Returns the counterpart pid to wake if
   * it might be parked on this pipe: a reader blocked on an empty pipe
   * whose writer just died would otherwise wait forever for data that can
   * never arrive, and a writer blocked on a full pipe whose reader died
   * has nobody left to drain it. Waking them is what lets both ends of a
   * pipeline actually terminate.
   *
   * A pipe whose two ends are both closed is dropped entirely, so a long
   * session doesn't accumulate dead channels.
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

  /** Open descriptors, for `lsof` — see roadmap-v5.md §2.2. */
  getMetrics() {
    return {
      openPipes: this.pipes.length,
      writtenTotal: this.pipes.reduce((sum, p) => sum + p.writtenTotal, 0),
      readTotal: this.pipes.reduce((sum, p) => sum + p.readTotal, 0),
      blockedEndpoints: this.pipes.filter((p) => p.buffer.length === 0 || p.buffer.length >= p.capacity).length,
    }
  }
}
