import type { DirEntry } from '../shared/types'
import { WindowFrame } from '../app/WindowFrame'
import { FilesystemIcon, FolderIcon, FileIcon, WarningIcon } from '../app/icons'
import { useSimStore } from '../app/store'
import { filesystem } from '../app/engines'
import { colorForPid } from '../app/colors'

function TreeNode({ entry, depth }: { entry: DirEntry; depth: number }) {
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
      {depth > 0 && (
        <div className="tree-row folder" style={{ paddingLeft: depth * 16 }}>
          <FolderIcon />
          {entry.name}/
        </div>
      )}
      {(entry.children ?? []).map((child) => (
        <TreeNode key={`${depth}-${child.name}`} entry={child} depth={depth + 1} />
      ))}
    </>
  )
}

export function FilesystemWindow() {
  useSimStore((s) => s.version) // subscribed purely so this window re-renders on every tick/command
  const runCommand = useSimStore((s) => s.runCommand)

  const tree = filesystem.getTree()
  const blocks = filesystem.getBlocks()
  const inodes = filesystem.getInodes()
  const journal = filesystem.getJournal()
  const crashed = filesystem.isCrashed()
  const metrics = filesystem.getMetrics()

  return (
    <WindowFrame
      id="filesystem"
      title="Filesystem"
      subtitle="inode-based · journaled"
      accent="var(--accent-fs)"
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
              <div className="ptable-row head" style={{ gridTemplateColumns: '40px 56px 46px 40px' }}>
                <span>ID</span>
                <span>Size</span>
                <span>Blk</span>
                <span>Lnk</span>
              </div>
              {inodes.map((inode) => (
                <div className="ptable-row" style={{ gridTemplateColumns: '40px 56px 46px 40px' }} key={inode.id}>
                  <span>{inode.id}</span>
                  <span>{inode.size}B</span>
                  <span>{inode.blockIds.length}</span>
                  <span>{inode.links}</span>
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
            <div className="disk-grid" style={{ marginTop: 8 }}>
              {blocks.map((b) => (
                <div
                  key={b.index}
                  className={`cell${b.owner === null ? ' free' : ''}`}
                  style={b.owner !== null ? { background: colorForPid(b.owner) } : undefined}
                  title={b.owner !== null ? `inode ${b.owner}` : 'free'}
                >
                  {b.owner === null ? '·' : `I${b.owner}`}
                </div>
              ))}
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
