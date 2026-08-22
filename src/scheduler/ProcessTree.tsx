import { useState } from 'react'
import { INIT_PID, SHELL_PID, type Process } from '../shared/types'
import { colorForPid } from '../app/colors'

const STATE_PILL_CLASS: Record<string, string> = {
  RUNNING: 'pill--running',
  READY: 'pill--ready',
  WAITING: 'pill--waiting',
  STOPPED: 'pill--stopped',
  TERMINATED: 'pill--terminated',
  NEW: 'pill--ready',
}

function TreeChildren({ pid, byParent, depth }: { pid: number; byParent: Map<number, Process[]>; depth: number }) {
  const children = byParent.get(pid) ?? []
  if (children.length === 0) return null
  return (
    <>
      {children.map((p) => (
        <div key={p.pid}>
          <div className="tree-row" style={{ paddingLeft: depth * 16 }}>
            <span className="dot" style={{ background: colorForPid(p.pid) }} />P{p.pid} {p.name}
            <span className={`pill ${STATE_PILL_CLASS[p.state]}`} style={{ marginLeft: 'auto' }}>
              {p.state}
            </span>
          </div>
          <TreeChildren pid={p.pid} byParent={byParent} depth={depth + 1} />
        </div>
      ))}
    </>
  )
}

/**
 * The parentPid-derived tree, plus which parentPid keys need to be surfaced
 * as their own root branch because the process that would normally anchor
 * them there is gone. Split out from `ProcessTree` so this — and the
 * `.map()`/`.filter()` passes it takes over `processes` — only ever runs
 * while the (collapsed-by-default) panel is actually open, not on every
 * tick's render (found by code review).
 */
function ProcessTreeBody({ processes }: { processes: Process[] }) {
  const byParent = new Map<number, Process[]>()
  for (const p of processes) {
    const list = byParent.get(p.parentPid) ?? []
    list.push(p)
    byParent.set(p.parentPid, list)
  }

  // A thread group's followers (roadmap-v4.md §2.1) point parentPid at
  // their leader's pid, not at SHELL_PID directly. If the leader itself
  // later terminates and ages out of SchedulerEngine's bounded terminated
  // history (MAX_TERMINATED_HISTORY), its pid disappears from `processes`
  // entirely — it's still a key in byParent (its still-running followers
  // reference it), but nothing ever recurses INTO that key, since only an
  // actual node's own pid ever gets passed to <TreeChildren>. Without this,
  // those followers become permanently unreachable here even though `ps`/
  // the Gantt chart still show them.
  //
  // Grouped directly by `Process.memoryOwnerPid` — the real, stable source
  // of truth for "which group is this pid in" (every ordinary process has
  // memoryOwnerPid === its own pid; only a thread follower points it at its
  // leader) — rather than re-deriving the same fact by scanning byParent's
  // keys for ones that aren't INIT_PID/SHELL_PID/a known pid (found by code
  // review: that patched the symptom without naming the actual mechanism,
  // and only happened to work because thread followers are the one case
  // where parentPid is ever set to a real process's own pid at all).
  const knownPids = new Set(processes.map((p) => p.pid))
  const orphanedLeaderPids = [
    ...new Set(
      processes.filter((p) => p.memoryOwnerPid !== p.pid && !knownPids.has(p.memoryOwnerPid)).map((p) => p.memoryOwnerPid),
    ),
  ]

  return (
    <div className="tree-panel" style={{ maxHeight: 170 }}>
      <div className="tree-row folder">init</div>
      <TreeChildren pid={INIT_PID} byParent={byParent} depth={1} />
      <div className="tree-row folder">shell</div>
      <TreeChildren pid={SHELL_PID} byParent={byParent} depth={1} />
      {orphanedLeaderPids.map((pid) => (
        <TreeChildren key={pid} pid={pid} byParent={byParent} depth={1} />
      ))}
    </div>
  )
}

/** Collapsible parent/child process tree — roadmap.md §2.2. Every real process hangs off one of two synthetic roots: "shell" (spawned via the terminal's `run`) or "init" (the automatic background workload). */
export function ProcessTree({ processes }: { processes: Process[] }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="field">
      <button type="button" className="tree-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="label">Process tree {open ? '▾' : '▸'}</span>
      </button>
      {open && <ProcessTreeBody processes={processes} />}
    </div>
  )
}
