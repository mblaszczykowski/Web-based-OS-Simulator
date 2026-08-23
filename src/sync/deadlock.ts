export type DeadlockActorId = 1 | 2
export type ResourceId = 'R1' | 'R2'

export type DeadlockStep =
  | 'idle'
  | 'p1-acquired-r1'
  | 'p2-acquired-r2'
  | 'p1-blocked-on-r2'
  | 'deadlocked'
  | 'resolved'

export interface WaitForEdge {
  from: DeadlockActorId
  to: DeadlockActorId
}

const OTHER: Record<DeadlockActorId, DeadlockActorId> = { 1: 2, 2: 1 }

export class DeadlockEngine {
  private step: DeadlockStep = 'idle'
  private heldBy: Record<ResourceId, DeadlockActorId | null> = { R1: null, R2: null }
  private wants: Record<DeadlockActorId, ResourceId | null> = { 1: null, 2: null }

  getStep(): DeadlockStep {
    return this.step
  }

  getHeldBy(): Record<ResourceId, DeadlockActorId | null> {
    return { ...this.heldBy }
  }

  getWants(): Record<DeadlockActorId, ResourceId | null> {
    return { ...this.wants }
  }

  getWaitForGraph(): WaitForEdge[] {
    const edges: WaitForEdge[] = []
    for (const actor of [1, 2] as const) {
      const wanted = this.wants[actor]
      const holder = wanted ? this.heldBy[wanted] : null
      if (holder !== null && holder !== actor) edges.push({ from: actor, to: holder })
    }
    return edges
  }

  hasCycle(): boolean {
    const edges = new Map(this.getWaitForGraph().map((e) => [e.from, e.to]))
    for (const start of [1, 2] as const) {
      const path = new Set<DeadlockActorId>()
      let current: DeadlockActorId | undefined = start
      while (current !== undefined) {
        if (path.has(current)) return true
        path.add(current)
        current = edges.get(current)
      }
    }
    return false
  }

  advance(): void {
    switch (this.step) {
      case 'idle':
        this.heldBy.R1 = 1
        this.step = 'p1-acquired-r1'
        return
      case 'p1-acquired-r1':
        this.heldBy.R2 = 2
        this.step = 'p2-acquired-r2'
        return
      case 'p2-acquired-r2':
        this.wants[1] = 'R2'
        this.step = 'p1-blocked-on-r2'
        return
      case 'p1-blocked-on-r2':
        this.wants[2] = 'R1'
        this.step = this.hasCycle() ? 'deadlocked' : 'p1-blocked-on-r2'
        return
      case 'deadlocked':
      case 'resolved':
        return
    }
  }

  breakDeadlock(victim: DeadlockActorId): void {
    if (this.step !== 'deadlocked') return
    const survivor = OTHER[victim]

    for (const resource of ['R1', 'R2'] as const) {
      if (this.heldBy[resource] === victim) this.heldBy[resource] = null
    }
    this.wants[victim] = null

    const survivorWants = this.wants[survivor]
    if (survivorWants && this.heldBy[survivorWants] === null) {
      this.heldBy[survivorWants] = survivor
      this.wants[survivor] = null
    }
    this.step = 'resolved'
  }

  reset(): void {
    this.step = 'idle'
    this.heldBy = { R1: null, R2: null }
    this.wants = { 1: null, 2: null }
  }
}
