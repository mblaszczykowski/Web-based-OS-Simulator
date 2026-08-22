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

/** Collapsible parent/child process tree — roadmap.md §2.2. Every real process hangs off one of two synthetic roots: "shell" (spawned via the terminal's `run`) or "init" (the automatic background workload). */
export function ProcessTree({ processes }: { processes: Process[] }) {
  const [open, setOpen] = useState(false)

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
  // the Gantt chart still show them. Every thread group is spawned via the
  // terminal (SHELL_PID-rooted), so surfacing an orphaned branch under
  // "shell" — with no row for the vanished leader, since there's no
  // Process left to render one from — is the correct fallback.
  const knownPids = new Set(processes.map((p) => p.pid))
  const orphanedParentPids = [...byParent.keys()].filter(
    (pid) => pid !== INIT_PID && pid !== SHELL_PID && !knownPids.has(pid),
  )

  return (
    <div className="field">
      <button type="button" className="tree-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="label">Process tree {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tree-panel" style={{ maxHeight: 170 }}>
          <div className="tree-row folder">init</div>
          <TreeChildren pid={INIT_PID} byParent={byParent} depth={1} />
          <div className="tree-row folder">shell</div>
          <TreeChildren pid={SHELL_PID} byParent={byParent} depth={1} />
          {orphanedParentPids.map((pid) => (
            <TreeChildren key={pid} pid={pid} byParent={byParent} depth={1} />
          ))}
        </div>
      )}
    </div>
  )
}
