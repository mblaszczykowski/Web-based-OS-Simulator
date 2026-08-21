// A small typed pub/sub bus. This is what actually keeps the modules
// independent per the architecture in plan.md §5: the scheduler engine has
// no idea the terminal exists, it just emits `process:terminated`; the
// terminal (or anything else) can subscribe and react without either side
// importing the other.

export type SimEventMap = {
  'process:spawned': { pid: number; name: string; kind: string }
  'process:terminated': { pid: number; name: string; reason: 'natural' | 'killed' }
  'process:state-changed': { pid: number; from: string; to: string }
  'memory:page-fault': { pid: number; page: number; victimFrame: number | null }
  'memory:allocated': { pid: number; frames: number[] }
  'memory:freed': { pid: number; frames: number[] }
  'fs:mutated': { op: string; path: string }
  'fs:crashed': Record<string, never>
  'fs:recovered': { replayed: number }
}

type Listener<T> = (payload: T) => void

export class EventBus<Events extends Record<string, unknown>> {
  private listeners: { [K in keyof Events]?: Set<Listener<Events[K]>> } = {}

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const set = (this.listeners[event] ??= new Set())
    set.add(listener)
    return () => set.delete(listener)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.listeners[event]?.forEach((listener) => listener(payload))
  }
}

/** Singleton bus shared by the whole app — see plan.md §5. */
export const simBus = new EventBus<SimEventMap>()
