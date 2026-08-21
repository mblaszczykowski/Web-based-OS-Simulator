import type { SyncActor, SyncActorState, SyncLogEntry, SyncRole } from '../shared/types'

export const SYNC_BUFFER_CAPACITY = 6
const PRODUCER_COUNT = 2
const CONSUMER_COUNT = 2
const LOG_LIMIT = 40

/** A classic counting semaphore — capped at `capacity` so release() can never over-signal past it. */
class CountingSemaphore {
  constructor(
    public count: number,
    private readonly capacity: number,
  ) {}

  tryAcquire(): boolean {
    if (this.count <= 0) return false
    this.count--
    return true
  }

  release(): void {
    this.count = Math.min(this.capacity, this.count + 1)
  }
}

export interface SyncMetrics {
  producedTotal: number
  consumedTotal: number
  /** Slots actually holding an item right now — ground truth, read straight off the buffer. */
  realOccupancy: number
  /** What occupancy the semaphore bookkeeping *thinks* it is (capacity - empty permits available). */
  expectedOccupancy: number
  /** Times a producer overwrote an unconsumed slot or a consumer read an empty one — only possible in unsafe mode. */
  corruptionEvents: number
  mutexLocked: boolean
  semEmptyCount: number
  semFullCount: number
}

/**
 * Bounded-buffer producer/consumer — roadmap.md §1.3. Two producers, two
 * consumers, a circular buffer guarded by a counting semaphore pair
 * (empty/full slots) plus a mutex around the actual slot write/read. This
 * is the module's only mechanism in "safe" mode (per ADR-0001's spirit —
 * one well-justified approach, not a comparison of options); `unsafe`
 * exists solely to *demonstrate* the bug the mutex prevents, the same
 * narrative pattern as crash/fsck in the filesystem module ("here's what
 * breaks, here's the fix"), not as a second, equally-valid mode.
 *
 * Deliberately single-threaded/synchronous like the rest of this
 * simulator (see plan.md §3) — there's no real concurrency to race. The
 * "race condition" is instead modelled explicitly: entering the critical
 * section captures the buffer slot to act on, and committing it (writing
 * the slot, advancing the shared pointer, releasing the lock) happens a
 * tick later. In safe mode the mutex guarantees only one actor is ever
 * between those two steps. In unsafe mode it doesn't, so two producers can
 * both capture the same slot before either commits — exactly the
 * textbook lost-update race.
 */
export class SyncEngine {
  private actors: SyncActor[] = []
  private buffer: (number | null)[] = Array(SYNC_BUFFER_CAPACITY).fill(null)
  private inPtr = 0
  private outPtr = 0
  private nextItemSeq = 1
  private producedTotal = 0
  private consumedTotal = 0
  private corruptionEvents = 0
  private tickCount = 0
  private log: SyncLogEntry[] = []
  private nextLogId = 1

  private semEmpty = new CountingSemaphore(SYNC_BUFFER_CAPACITY, SYNC_BUFFER_CAPACITY)
  private semFull = new CountingSemaphore(0, SYNC_BUFFER_CAPACITY)
  private mutex = new CountingSemaphore(1, 1)

  constructor(public readonly unsafe = false) {
    let id = 1
    for (let i = 0; i < PRODUCER_COUNT; i++) this.actors.push(this.makeActor(id++, 'producer'))
    for (let i = 0; i < CONSUMER_COUNT; i++) this.actors.push(this.makeActor(id++, 'consumer'))
  }

  private makeActor(id: number, role: SyncRole): SyncActor {
    return { id, role, state: 'idle', itemsHandled: 0, capturedSlot: null }
  }

  private pushLog(text: string, kind: SyncLogEntry['kind'] = 'info'): void {
    this.log.push({ id: this.nextLogId++, text, kind })
    if (this.log.length > LOG_LIMIT) this.log.shift()
  }

  private label(actor: SyncActor): string {
    return `${actor.role === 'producer' ? 'P' : 'C'}${actor.id}`
  }

  tick(): void {
    this.tickCount++
    // Rotate who goes first each tick so no single actor perpetually wins contested resources.
    const n = this.actors.length
    const start = this.tickCount % n
    const order = [...this.actors.slice(start), ...this.actors.slice(0, start)]
    for (const actor of order) this.stepActor(actor)
  }

  private stepActor(actor: SyncActor): void {
    switch (actor.state) {
      case 'idle': {
        const sem = actor.role === 'producer' ? this.semEmpty : this.semFull
        const waitState: SyncActorState = actor.role === 'producer' ? 'waiting-empty' : 'waiting-full'
        if (sem.tryAcquire()) {
          actor.state = 'waiting-mutex'
        } else {
          actor.state = waitState
          this.pushLog(`${this.label(actor)} blocked on ${actor.role === 'producer' ? 'empty' : 'full'}`, 'block')
        }
        break
      }

      case 'waiting-empty':
      case 'waiting-full': {
        const sem = actor.role === 'producer' ? this.semEmpty : this.semFull
        if (sem.tryAcquire()) actor.state = 'waiting-mutex'
        break
      }

      case 'waiting-mutex': {
        const acquired = this.unsafe || this.mutex.tryAcquire()
        if (!acquired) break
        actor.capturedSlot = actor.role === 'producer' ? this.inPtr : this.outPtr
        actor.state = 'in-critical-section'
        this.pushLog(`${this.label(actor)} entered critical section (slot ${actor.capturedSlot})`)
        break
      }

      case 'in-critical-section': {
        this.commit(actor)
        break
      }
    }
  }

  private commit(actor: SyncActor): void {
    const slot = actor.capturedSlot!
    if (actor.role === 'producer') {
      if (this.buffer[slot] !== null) {
        this.corruptionEvents++
        this.pushLog(`⚠ ${this.label(actor)} overwrote an unconsumed item in slot ${slot}!`, 'warning')
      }
      this.buffer[slot] = this.nextItemSeq++
      this.inPtr = (slot + 1) % this.buffer.length
      this.producedTotal++
    } else {
      if (this.buffer[slot] === null) {
        this.corruptionEvents++
        this.pushLog(`⚠ ${this.label(actor)} consumed an already-empty slot ${slot}!`, 'warning')
      }
      this.buffer[slot] = null
      this.outPtr = (slot + 1) % this.buffer.length
      this.consumedTotal++
    }

    actor.itemsHandled++
    actor.capturedSlot = null
    if (!this.unsafe) this.mutex.release()
    const otherSem = actor.role === 'producer' ? this.semFull : this.semEmpty
    otherSem.release()
    this.pushLog(`${this.label(actor)} committed slot ${slot} and released`)
    actor.state = 'idle'
  }

  getActors(): SyncActor[] {
    return this.actors
  }

  getBuffer(): (number | null)[] {
    return this.buffer
  }

  getPointers(): { inPtr: number; outPtr: number } {
    return { inPtr: this.inPtr, outPtr: this.outPtr }
  }

  getLog(): SyncLogEntry[] {
    return this.log
  }

  getMetrics(): SyncMetrics {
    return {
      producedTotal: this.producedTotal,
      consumedTotal: this.consumedTotal,
      realOccupancy: this.buffer.filter((x) => x !== null).length,
      expectedOccupancy: this.buffer.length - this.semEmpty.count,
      corruptionEvents: this.corruptionEvents,
      mutexLocked: this.mutex.count === 0,
      semEmptyCount: this.semEmpty.count,
      semFullCount: this.semFull.count,
    }
  }
}
