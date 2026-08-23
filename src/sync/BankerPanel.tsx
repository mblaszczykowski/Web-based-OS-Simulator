import { useState } from 'react'
import { banker } from '../app/engines'
import { RESOURCE_NAMES, PROCESS_COUNT } from './banker'

const PROCESS_IDS = Array.from({ length: PROCESS_COUNT }, (_, i) => i)
const MATRIX_COLUMNS = `36px repeat(${RESOURCE_NAMES.length}, 1fr)`

function Matrix({ title, rows }: { title: string; rows: number[][] }) {
  return (
    <div className="field">
      <span className="label">{title}</span>
      <div className="ptable-wrap" style={{ maxHeight: 150 }}>
        <div className="ptable-row head" style={{ gridTemplateColumns: MATRIX_COLUMNS }}>
          <span />
          {RESOURCE_NAMES.map((r) => (
            <span key={r}>{r}</span>
          ))}
        </div>
        {rows.map((row, p) => (
          <div className="ptable-row" style={{ gridTemplateColumns: MATRIX_COLUMNS }} key={p}>
            <span>P{p}</span>
            {row.map((v, i) => (
              <span key={i}>{v}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export function BankerPanel() {
  const [, forceRender] = useState(0)
  const rerender = () => forceRender((n) => n + 1)

  const [pid, setPid] = useState(0)
  const [req, setReq] = useState<number[]>(() => RESOURCE_NAMES.map(() => 0))

  const allocation = banker.getAllocation()
  const max = banker.getMax()
  const need = banker.getNeed()
  const available = banker.getAvailable()
  const log = banker.getLog()
  const { safe, sequence } = banker.checkCurrentSafety()

  function submitRequest() {
    banker.request(pid, req)
    rerender()
  }

  function resetScenario() {
    banker.reset()
    setReq(RESOURCE_NAMES.map(() => 0))
    rerender()
  }

  return (
    <div className="win-body">
      <div className="sched-sidebar">
        <div className="field">
          <span className="label">Mechanism</span>
          <div className="algo-readout">
            <span className="algo-dot" />
            <span className="algo-name">Banker&rsquo;s Algorithm</span>
          </div>
          <span className="algo-desc">
            5 processes, 3 resource types &mdash; Silberschatz&rsquo;s own worked example. Every request runs the
            safety algorithm <em>before</em> being granted: if it could ever lead to a state where no process can
            finish, it&rsquo;s denied and rolled back outright &mdash; avoidance, not detection (see the Deadlock
            detection tab for that complementary approach).
          </span>
        </div>

        <div className="field">
          <span className="label">Current state</span>
          <span className="stat-value" style={{ fontSize: 13, color: safe ? undefined : 'var(--critical)' }}>
            {safe ? `Safe — sequence <${sequence.map((p) => `P${p}`).join(', ')}>` : 'UNSAFE'}
          </span>
        </div>

        <div className="field">
          <span className="label">Request resources</span>
          <div className="banker-request-row">
            <select
              className="banker-select"
              value={pid}
              onChange={(e) => setPid(Number(e.target.value))}
              aria-label="Process to request resources on behalf of"
            >
              {PROCESS_IDS.map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
            {RESOURCE_NAMES.map((r, i) => (
              <label key={r} className="banker-qty-label">
                {r}
                <input
                  type="number"
                  min={0}
                  className="banker-input"
                  value={req[i]}
                  onChange={(e) => {
                    const next = Math.max(0, Math.floor(Number(e.target.value) || 0))
                    setReq((prev) => prev.map((v, j) => (j === i ? next : v)))
                  }}
                  aria-label={`Requested units of resource ${r}`}
                />
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-outline" onClick={submitRequest}>
              Request
            </button>
            <button type="button" className="btn-outline" onClick={resetScenario}>
              Reset scenario
            </button>
          </div>
        </div>
      </div>

      <div className="sched-main">
        <div className="split-row">
          <div className="split-col">
            <Matrix title="Allocation" rows={allocation} />
          </div>
          <div className="split-col">
            <Matrix title="Max" rows={max} />
          </div>
        </div>
        <div className="split-row">
          <div className="split-col">
            <Matrix title="Need (Max − Allocation)" rows={need} />
          </div>
          <div className="split-col">
            <div className="field">
              <span className="label">Available</span>
              <div className="ptable-wrap">
                <div className="ptable-row head" style={{ gridTemplateColumns: `repeat(${RESOURCE_NAMES.length}, 1fr)` }}>
                  {RESOURCE_NAMES.map((r) => (
                    <span key={r}>{r}</span>
                  ))}
                </div>
                <div className="ptable-row" style={{ gridTemplateColumns: `repeat(${RESOURCE_NAMES.length}, 1fr)` }}>
                  {available.map((v, i) => (
                    <span key={i}>{v}</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="field" style={{ flexGrow: 1, minHeight: 0 }}>
          <span className="label">Request log</span>
          <div className="sync-log">
            {log.length === 0 && <span className="term-muted">no requests yet</span>}
            {log.map((entry) => (
              <div className={`sync-log-row sync-log-row--${entry.kind}`} key={entry.id}>
                {entry.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
