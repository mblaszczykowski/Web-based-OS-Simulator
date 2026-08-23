import type { DirEntry, DiskBlock } from '../shared/types'
import { WindowFrame } from '../app/WindowFrame'
import { FilesystemIcon, FolderIcon, FileIcon, WarningIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { filesystem, scheduler } from '../app/engines'
import { rwxTriplet } from './engine'
import { colorForPid, labelColorForPid } from '../app/colors'

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
  if (entry.type === 'symlink') {
    return (
      <div className="tree-row file" style={{ paddingLeft: depth * 16 }} title={`symbolic link → ${entry.target ?? '?'}`}>
        <FileIcon />
        <span>
          {entry.name} <span className="term-muted">&rarr; {entry.target}</span>
        </span>
      </div>
    )
  }
  if (entry.type === 'file') {
    return (
      <div className="tree-row file" style={{ paddingLeft: depth * 16 }}>
        <FileIcon />
        {entry.name}
      </div>
    )
  }
  return (
    <>
      <div className="tree-row folder" style={{ paddingLeft: depth * 16 }}>
        <FolderIcon />
        {entry.name}/
      </div>
      {(entry.children ?? []).map((child) => (
        <TreeNode key={`${depth}-${child.name}`} entry={child} depth={depth + 1} />
      ))}
    </>
  )
}

type IoCellKind = 'head' | 'pending' | 'owned' | 'free'

function ioCellKind(block: DiskBlock, headPosition: number, pendingBlocks: Set<number>): IoCellKind {
  if (block.index === headPosition) return 'head'
  if (pendingBlocks.has(block.index)) return 'pending'
  if (block.owner !== null) return 'owned'
  return 'free'
}

const IO_CELL_STYLE: Record<
  IoCellKind,
  { className: string; glyph: (b: DiskBlock) => string; title: (b: DiskBlock) => string }
> = {
  head: { className: 'io-head', glyph: () => 'H', title: () => 'disk head' },
  pending: { className: 'io-pending', glyph: () => '•', title: () => 'pending I/O request' },
  owned: { className: 'io-owned', glyph: () => 'o', title: (b) => `inode ${b.owner} (idle)` },
  free: { className: 'free', glyph: () => '·', title: () => 'idle' },
}

export function FilesystemWindow() {
  useSimStore((s) => s.version)
  const runCommand = useSimStore((s) => s.runCommand)

  const tree = filesystem.getTree()
  const blocks = filesystem.getBlocks()
  const inodes = filesystem.getInodes()
  const journal = filesystem.getJournal()
  const crashed = filesystem.isCrashed()
  const metrics = filesystem.getMetrics()
  const freeSpaceBitmap = filesystem.getFreeSpaceBitmap()
  const ioState = filesystem.getIoState()
  const ioMetrics = filesystem.getIoMetrics()
  const blockedOnDisk = scheduler.getProcesses().filter((p) => p.blockedOn === 'device')

  return (
    <WindowFrame
      id="filesystem"
      title="Filesystem"
      subtitle="inode-based · journaled"
      accent="var(--accent)"
      icon={<FilesystemIcon />}
    >
      <div className="win-body">
        <div className="fs-sidebar">
          <div className="field" style={{ flexGrow: 1, minHeight: 0 }}>
            <span className="label">File tree</span>
            <div className="tree-panel">
              <div className="tree-row folder">
                <FolderIcon />/
              </div>
              {(tree.children ?? []).map((child) => (
                <TreeNode key={child.name} entry={child} depth={1} />
              ))}
              {(tree.children ?? []).length === 0 && <span className="term-muted">empty</span>}
            </div>
          </div>
          <div className="field">
            <span className="label">Inodes &mdash; {inodes.length}</span>
            <div className="ptable-wrap" style={{ maxHeight: 120 }}>
              <div className="ptable-row head" style={{ gridTemplateColumns: '40px 56px 46px 40px 50px' }}>
                <span>ID</span>
                <span>Size</span>
                <span>Blk</span>
                <span>Lnk</span>
                <span>Mode</span>
              </div>
              {inodes.map((inode) => (
                <div className="ptable-row" style={{ gridTemplateColumns: '40px 56px 46px 40px 50px' }} key={inode.id}>
                  <span>{inode.id}</span>
                  <span>{inode.size}B</span>
                  <span>{inode.blockIds.length}</span>
                  <span>{inode.links}</span>
                  <span>{rwxTriplet(inode.mode)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="fs-main">
          <div>
            <div className="row-between">
              <span className="label">
                Disk blocks &mdash; {metrics.usedBlocks}/{metrics.totalBlocks} used
              </span>
              <div className="legend">
                <span className="legend-item">
                  <span className="swatch" style={{ border: '1px dashed var(--border-strong)' }} />
                  free
                </span>
              </div>
            </div>
            {/* — the free-space bit vector the allocator
                actually consults, next to the block grid it describes. One
                cell per block, so the two line up row for row. */}
            <div className="bitmap-strip" style={{ marginTop: 8 }} title="Free-space bitmap: filled = allocated">
              {freeSpaceBitmap.map((allocated, index) => (
                <span key={index} className={`bitmap-bit${allocated ? ' allocated' : ''}`} />
              ))}
            </div>
            <div className="disk-grid" style={{ marginTop: 8 }}>
              {blocks.map((b) => (
                <div
                  key={b.index}
                  className={`cell${b.owner === null ? ' free' : ''}`}
                  style={
                    b.owner !== null ? { background: colorForPid(b.owner), color: labelColorForPid(b.owner) } : undefined
                  }
                  title={b.owner !== null ? `inode ${b.owner}` : 'free'}
                >
                  {b.owner === null ? '·' : `I${b.owner}`}
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="row-between">
              <span className="label">
                I/O scheduler (SCAN) &mdash; head @ cylinder {ioState.headPosition}/{blocks.length - 1}, queue{' '}
                {ioMetrics.pendingCount}
              </span>
              <div className="legend">
                <span className="legend-item">
                  <span className="swatch cell io-head" />
                  head
                </span>
                <span className="legend-item">
                  <span className="swatch cell io-pending" />
                  pending
                </span>
                <span className="legend-item">
                  <span className="swatch cell io-owned" />
                  owned, idle
                </span>
              </div>
            </div>
            <div className="disk-grid" style={{ marginTop: 8 }}>
              {(() => {
                const pendingBlocks = new Set(ioState.pending.map((r) => r.blockIndex))
                return blocks.map((b) => {
                  const kind = ioCellKind(b, ioState.headPosition, pendingBlocks)
                  return (
                    <div key={b.index} className={`cell ${IO_CELL_STYLE[kind].className}`} title={IO_CELL_STYLE[kind].title(b)}>
                      {IO_CELL_STYLE[kind].glyph(b)}
                    </div>
                  )
                })
              })()}
            </div>
            <div className="algo-desc" style={{ marginTop: 6 }}>
              Avg seek: {ioMetrics.avgSeekDistance.toFixed(1)} cylinders &middot; Avg wait: {ioMetrics.avgWaitTicks.toFixed(1)}{' '}
              ticks &middot; Completed: {ioMetrics.completedCount}
              {/* — the point of the whole integration: these
                  are real processes sitting in WAITING until this head reaches
                  them, not a queue of anonymous block numbers. */}
              {blockedOnDisk.length > 0 && (
                <>
                  {' '}
                  &middot; blocking {blockedOnDisk.map((p) => `P${p.pid}`).join(', ')}
                </>
              )}
            </div>
          </div>

          <div className="split-row">
            <div className="split-col">
              <span className="label">Journal / operations</span>
              <div className="log-panel">
                {journal.length === 0 && <span className="term-muted">no operations yet</span>}
                {journal
                  .slice()
                  .reverse()
                  .slice(0, 12)
                  .map((entry) => (
                    <div className="log-row" key={entry.id}>
                      <span className={`log-verb ${entry.op}`}>{entry.op.toUpperCase()}</span>
                      <span className="log-path">{entry.path}</span>
                      <span className="log-time">{entry.status === 'pending' ? 'PENDING' : 'ok'}</span>
                    </div>
                  ))}
              </div>
            </div>
            <div className="split-col">
              <span className="label">Crash &amp; recovery</span>
              <div className="crash-panel">
                <span className="algo-desc">
                  Status: {crashed ? `crashed — ${metrics.pendingJournalEntries} pending` : 'consistent'}
                </span>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={crashed}
                  onClick={() => runCommand('crash')}
                >
                  <WarningIcon />
                  Simulate crash
                </button>
                <button type="button" className="btn-outline" disabled={!crashed} onClick={() => runCommand('fsck')}>
                  Recover (fsck)
                </button>
                <button type="button" className="btn-outline" onClick={() => runCommand('reset-fs')}>
                  Reset disk
                </button>
                <div className="journal-log">
                  {journal
                    .slice()
                    .reverse()
                    .slice(0, 6)
                    .map((entry) => (
                      <div className="jlog-row" key={entry.id}>
                        <span className={`jtag ${entry.status === 'pending' ? 'crash' : 'ok'}`}>
                          [{entry.status === 'pending' ? 'PENDING' : 'OK'}]
                        </span>
                        <span className="jtext">
                          {entry.op} {entry.path}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </WindowFrame>
  )
}
