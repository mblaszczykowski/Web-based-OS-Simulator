import { useEffect, useRef, useState } from 'react'
import type { DeadlockActorId } from './deadlock'
import { WarningIcon } from '../app/icons'
import { deadlock as engine } from '../app/engines'

const STEP_DELAY_MS = 750

const STEP_LABEL: Record<string, string> = {
  idle: 'Not started',
  'p1-acquired-r1': 'P1 acquired R1',
  'p2-acquired-r2': 'P2 acquired R2',
  'p1-blocked-on-r2': 'P1 requests R2 — blocked (held by P2)',
  deadlocked: 'DEADLOCK — circular wait detected',
  resolved: 'Resolved',
}

// Fixed layout for a fixed 2-actor/2-resource graph — no reason to compute this dynamically.
const POS = { p1: { x: 50, y: 34 }, p2: { x: 230, y: 34 }, r1: { x: 50, y: 130 }, r2: { x: 230, y: 130 } }
const NODE_R = 20

function Arrow({
  x1,
  y1,
  x2,
  y2,
  dashed,
  active,
}: {
  x1: number
  y1: number
  x2: number
  y2: number
  dashed?: boolean
  active?: boolean
}) {
  // Shorten the line so the arrowhead lands just outside the target node's circle/rect.
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const pad = NODE_R + 6
  const ex = x2 - (dx / len) * pad
  const ey = y2 - (dy / len) * pad
  const sx = x1 + (dx / len) * pad
  const sy = y1 + (dy / len) * pad
  return (
    <line
      x1={sx}
      y1={sy}
      x2={ex}
      y2={ey}
      stroke={active ? 'var(--critical)' : 'var(--text-secondary)'}
      strokeWidth={active ? 2.5 : 1.6}
      strokeDasharray={dashed ? '5 4' : undefined}
      markerEnd={active ? 'url(#arrow-critical)' : 'url(#arrow-normal)'}
    />
  )
}

export function DeadlockPanel() {
  const [, forceRender] = useState(0)
  const runTokenRef = useRef(0)

  const rerender = () => forceRender((n) => n + 1)

  useEffect(() => () => {
    runTokenRef.current++ // unmounting mid-run — invalidate any pending timers
  }, [])

  function runScenario() {
    if (engine.getStep() !== 'idle' && engine.getStep() !== 'resolved') return
    if (engine.getStep() === 'resolved') engine.reset()
    const token = ++runTokenRef.current
    const step = () => {
      if (runTokenRef.current !== token) return
      engine.advance()
      rerender()
      if (engine.getStep() !== 'deadlocked') {
        window.setTimeout(step, STEP_DELAY_MS)
      }
    }
    step()
  }

  function breakDeadlock(victim: DeadlockActorId) {
    engine.breakDeadlock(victim)
    rerender()
  }

  function reset() {
    runTokenRef.current++
    engine.reset()
    rerender()
  }

  const step = engine.getStep()
  const held = engine.getHeldBy()
  const wants = engine.getWants()
  const deadlocked = step === 'deadlocked'
  // Gated on the actual detected cycle, not just "the wait-for graph has
  // any edges" — one actor waiting on another (e.g. the 'p1-blocked-on-r2'
  // step) is a real edge but not yet a cycle, and shouldn't render as
  // critical/red before hasCycle() actually says so.
  const cycleEdges = new Set(deadlocked ? engine.getWaitForGraph().map((e) => `${e.from}-${e.to}`) : [])

  return (
    <div className="win-body">
      <div className="sched-sidebar">
        <div className="field">
          <span className="label">Mechanism</span>
          <div className="algo-readout">
            <span className="algo-dot" />
            <span className="algo-name">Wait-for graph cycle detection</span>
          </div>
          <span className="algo-desc">
            A scripted circular-wait scenario — two processes, two single-instance resources, each acquiring one and
            requesting the other. A DFS over the wait-for graph detects the resulting cycle, the same algorithm real
            deadlock detectors use.
          </span>
        </div>

        <div className="field">
          <span className="label">Status</span>
          <span className="stat-value" style={{ fontSize: 13, color: deadlocked ? 'var(--critical)' : undefined }}>
            {STEP_LABEL[step]}
          </span>
        </div>

        {deadlocked && (
          <div className="crash-panel" style={{ borderColor: 'var(--critical)' }}>
            <span className="algo-desc" style={{ color: 'var(--critical)' }}>
              <WarningIcon /> P1 waits for P2, P2 waits for P1 — neither can proceed. This is what a Banker's
              Algorithm-style admission check, or a detector like this one, exists to catch.
            </span>
          </div>
        )}

        <div className="field" style={{ gap: 8 }}>
          <button
            type="button"
            className="btn-outline"
            disabled={step !== 'idle' && step !== 'resolved'}
            onClick={runScenario}
          >
            ▶ Run scenario
          </button>
          <button type="button" className="btn-danger" disabled={!deadlocked} onClick={() => breakDeadlock(2)}>
            <WarningIcon /> Break deadlock (kill P2)
          </button>
          <button type="button" className="btn-outline" onClick={reset}>
            Reset
          </button>
        </div>
      </div>

      <div className="sched-main">
        <span className="label">Resource-allocation graph</span>
        <svg viewBox="0 0 280 170" style={{ width: '100%', maxWidth: 420, height: 'auto' }} role="img" aria-label="Resource allocation graph showing which process holds and requests which resource">
          <defs>
            <marker id="arrow-normal" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="var(--text-secondary)" />
            </marker>
            <marker id="arrow-critical" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="var(--critical)" />
            </marker>
          </defs>

          {/* assignment edges: resource -> holder */}
          {held.R1 === 1 && <Arrow x1={POS.r1.x} y1={POS.r1.y} x2={POS.p1.x} y2={POS.p1.y} active={cycleEdges.has('2-1')} />}
          {held.R2 === 2 && <Arrow x1={POS.r2.x} y1={POS.r2.y} x2={POS.p2.x} y2={POS.p2.y} active={cycleEdges.has('1-2')} />}
          {held.R1 === 2 && <Arrow x1={POS.r1.x} y1={POS.r1.y} x2={POS.p2.x} y2={POS.p2.y} />}
          {held.R2 === 1 && <Arrow x1={POS.r2.x} y1={POS.r2.y} x2={POS.p1.x} y2={POS.p1.y} />}

          {/* request edges: actor -> resource it wants */}
          {wants[1] === 'R2' && <Arrow x1={POS.p1.x} y1={POS.p1.y} x2={POS.r2.x} y2={POS.r2.y} dashed active={cycleEdges.has('1-2')} />}
          {wants[2] === 'R1' && <Arrow x1={POS.p2.x} y1={POS.p2.y} x2={POS.r1.x} y2={POS.r1.y} dashed active={cycleEdges.has('2-1')} />}

          <circle cx={POS.p1.x} cy={POS.p1.y} r={NODE_R} fill="var(--accent-sync)" />
          <text x={POS.p1.x} y={POS.p1.y + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="#05070a">P1</text>
          <circle cx={POS.p2.x} cy={POS.p2.y} r={NODE_R} fill="var(--accent-terminal)" />
          <text x={POS.p2.x} y={POS.p2.y + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="#05070a">P2</text>

          <rect x={POS.r1.x - NODE_R} y={POS.r1.y - NODE_R} width={NODE_R * 2} height={NODE_R * 2} rx="4" fill="var(--bg-inset)" stroke="var(--border-strong)" />
          <text x={POS.r1.x} y={POS.r1.y + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--text-primary)">R1</text>
          <rect x={POS.r2.x - NODE_R} y={POS.r2.y - NODE_R} width={NODE_R * 2} height={NODE_R * 2} rx="4" fill="var(--bg-inset)" stroke="var(--border-strong)" />
          <text x={POS.r2.x} y={POS.r2.y + 4} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--text-primary)">R2</text>
        </svg>

        <div className="legend">
          <span className="legend-item">
            <svg width="14" height="8"><line x1="0" y1="4" x2="14" y2="4" stroke="var(--text-secondary)" strokeWidth="1.6" /></svg>
            resource → holder (assigned)
          </span>
          <span className="legend-item">
            <svg width="14" height="8"><line x1="0" y1="4" x2="14" y2="4" stroke="var(--text-secondary)" strokeWidth="1.6" strokeDasharray="4 3" /></svg>
            process → resource (requested)
          </span>
        </div>
      </div>
    </div>
  )
}
