import { useState } from 'react'
import { INIT_PID, SHELL_PID, type Process } from '../shared/types'
import { colorForPid } from '../app/colors'

const STATE_PILL_CLASS: Record<string, string> = {
  RUNNING: 'pill--running',
  READY: 'pill--ready',
  WAITING: 'pill--waiting',
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
        </div>
      )}
    </div>
  )
}
