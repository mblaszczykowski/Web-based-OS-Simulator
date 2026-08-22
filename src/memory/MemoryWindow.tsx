import { WindowFrame } from '../app/WindowFrame'
import { MemoryIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { memory, scheduler } from '../app/engines'
import { colorForPid, labelColorForPid } from '../app/colors'
import { TLB_CAPACITY } from './engine'

/** Renders a 0-1 ratio as a whole-number percentage — this file's own single formatting rule (found by code review: five separate call sites each inlined `Math.round(x * 100)}%`). */
function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`
}

export function MemoryWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command

  const frames = memory.getFrames()
  const clockHand = memory.getClockHand()
  const blocks = memory.getContiguousBlocks()
  const metrics = memory.getMetrics()
  const tlbEntries = memory.getTlbEntries()
  const usedFrames = frames.filter((f) => f.owner !== null).length
  const kernelFrames = frames.filter((f) => f.owner?.pid === 0).length

  const processes = scheduler.getProcesses()
  const focusProcess = scheduler.getRunning() ?? processes.find((p) => p.state !== 'TERMINATED')
  // A thread (roadmap-v4.md §2.1) has no page table of its own — its
  // group's shared one lives under memoryOwnerPid, which equals its own
  // pid for every ordinary process (found while double-checking this
  // window against the memoryOwnerPid change: this used focusProcess.pid
  // directly, so focusing a follower thread would have shown an empty
  // page table instead of the one it actually shares with its leader).
  const pageTable = focusProcess ? memory.getPageTable(focusProcess.memoryOwnerPid) : undefined

  const totalArena = blocks.reduce((sum, b) => sum + b.size, 0)

  return (
    <WindowFrame
      id="memory"
      title="Memory"
      subtitle={metrics.thrashing ? '⚠ thrashing' : 'Clock paging'}
      accent="var(--accent)"
      icon={<MemoryIcon />}
    >
      <div className="win-body">
        <div className="mem-sidebar">
          <div className="field">
            <span className="label">Page replacement</span>
            <div className="algo-readout">
              <span className="algo-dot" />
              <span className="algo-name" style={{ fontSize: 12 }}>
                Clock (2nd-chance)
              </span>
            </div>
          </div>
          <div className="field">
            <span className="label">
              Frames &mdash; {usedFrames}/{frames.length}
            </span>
          </div>
          <div className="field">
            <span className="label">Fragmentation &mdash; {pct(metrics.externalFragmentation)}</span>
            <div className="frag-bar">
              <div className="frag-external" style={{ width: `${metrics.externalFragmentation * 100}%` }} />
            </div>
            <div className="frag-key">
              <span>
                <span className="swatch" style={{ background: 'var(--accent-memory)' }} />
                external
              </span>
            </div>
          </div>
          <div className="stat-pair">
            <div className="stat">
              <span className="label">Faults</span>
              <span className="stat-value">{metrics.pageFaults}</span>
            </div>
            <div className="stat">
              <span className="label">Hit ratio</span>
              <span className="stat-value">{pct(metrics.hitRatio)}</span>
            </div>
          </div>
          <div className="field">
            <span className="label">Swapped to /swap</span>
            <span className="stat-value" style={{ fontSize: 15 }}>
              {metrics.swappedPages} page(s)
            </span>
          </div>
          <div className="field">
            <span className="label">TLB ({tlbEntries.length}/{TLB_CAPACITY}) &mdash; hit ratio {pct(metrics.tlbHitRatio)}</span>
            <div className="ptable-wrap" style={{ maxHeight: 110 }}>
              <div className="ptable-row head" style={{ gridTemplateColumns: '40px 44px 44px' }}>
                <span>PID</span>
                <span>Page</span>
                <span>Frame</span>
              </div>
              {tlbEntries.length === 0 ? (
                <div className="ptable-row">
                  <span className="term-muted">empty</span>
                </div>
              ) : (
                tlbEntries.map((e) => (
                  <div className="ptable-row" style={{ gridTemplateColumns: '40px 44px 44px' }} key={`${e.pid}:${e.page}`}>
                    <span>{e.pid}</span>
                    <span>{e.page}</span>
                    <span>{e.frame}</span>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="field">
            <span className="label">
              Recent fault rate (last 20) &mdash; {pct(metrics.recentFaultRate)}
            </span>
            {metrics.thrashing && (
              <span className="stat-value" style={{ color: 'var(--warning)', fontSize: 13 }}>
                ⚠ thrashing — paging is crowding out real work
              </span>
            )}
          </div>
        </div>

        <div className="mem-main">
          <div>
            <div className="row-between">
              <span className="label">
                RAM &mdash; {frames.length} frames &middot; {kernelFrames} kernel &middot; {usedFrames - kernelFrames} allocated
                &middot; {frames.length - usedFrames} free
              </span>
              <div className="legend">
                <span className="legend-item">
                  <span className="swatch" style={{ background: 'var(--kernel)' }} />
                  OS
                </span>
                <span className="legend-item">
                  <span className="swatch" style={{ border: '1px dashed var(--border-strong)' }} />
                  free
                </span>
              </div>
            </div>
            <div className="ram-grid" style={{ marginTop: 8 }}>
              {frames.map((f) => (
                <div
                  key={f.index}
                  className={`cell${f.owner === null ? ' free' : f.owner.pid === 0 ? ' kernel' : ''}${f.index === clockHand ? ' hand' : ''}`}
                  style={
                    f.owner && f.owner.pid !== 0
                      ? { background: colorForPid(f.owner.pid), color: labelColorForPid(f.owner.pid) }
                      : undefined
                  }
                  title={f.index === clockHand ? 'clock hand' : undefined}
                >
                  {f.owner === null ? '·' : f.owner.pid === 0 ? 'OS' : `P${f.owner.pid}`}
                </div>
              ))}
            </div>
          </div>

          <div className="split-row">
            <div className="split-col">
              <span className="label">
                Page table{' '}
                {focusProcess
                  ? focusProcess.memoryOwnerPid === focusProcess.pid
                    ? `— P${focusProcess.pid}`
                    : `— P${focusProcess.memoryOwnerPid} (shared with thread P${focusProcess.pid})`
                  : ''}
              </span>
              <div className="ptable-wrap">
                <div className="ptable-row head">
                  <span>Page</span>
                  <span>Frame</span>
                  <span>Valid</span>
                  <span>Ref</span>
                  <span>M</span>
                  <span>Sw</span>
                </div>
                {!pageTable || pageTable.length === 0 ? (
                  <div className="ptable-row">
                    <span className="term-muted">—</span>
                  </div>
                ) : (
                  pageTable.map((entry) => (
                    <div className="ptable-row" key={entry.page}>
                      <span>{entry.page}</span>
                      <span>{entry.frame ?? '—'}</span>
                      <span className={entry.valid ? 'valid-ok' : 'valid-no'}>{entry.valid ? '✓' : '✗'}</span>
                      <span>{entry.referenced ? 1 : 0}</span>
                      <span>{entry.modified ? 1 : 0}</span>
                      <span className={entry.swapped ? 'swap-yes' : 'valid-no'}>{entry.swapped ? 'S' : '—'}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div className="split-col">
              <span className="label">Contiguous allocation &mdash; First-Fit</span>
              <div className="alloc-panel">
                <div className="alloc-strip">
                  {blocks.map((b) => (
                    <div
                      key={b.id}
                      className={`alloc-seg${b.owner === null ? ' free' : ''}`}
                      style={{
                        flex: b.size,
                        background: b.owner !== null ? colorForPid(b.owner) : undefined,
                        color: b.owner !== null ? labelColorForPid(b.owner) : undefined,
                      }}
                    >
                      {b.owner !== null ? `P${b.owner}` : ''}
                    </div>
                  ))}
                </div>
                <div className="alloc-ruler">
                  <span>0 MB</span>
                  <span>{totalArena} MB</span>
                </div>
                <span className="alloc-caption">
                  {blocks.filter((b) => b.owner === null).length} free block(s) &middot;{' '}
                  {pct(metrics.externalFragmentation)} fragmented
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  )
}
