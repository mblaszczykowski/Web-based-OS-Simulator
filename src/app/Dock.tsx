import { useSimStore, type WindowId } from './store'
import { SchedulerIcon, MemoryIcon, FilesystemIcon, TerminalIcon, TraceIcon, SyncIcon, NetworkIcon } from './icons'

const DOCK_ITEMS: { id: WindowId; label: string; accent: string; icon: React.ReactNode }[] = [
  { id: 'scheduler', label: 'Scheduler', accent: 'var(--accent-scheduler)', icon: <SchedulerIcon size={19} /> },
  { id: 'memory', label: 'Memory', accent: 'var(--accent-memory)', icon: <MemoryIcon size={19} /> },
  { id: 'filesystem', label: 'Filesystem', accent: 'var(--accent-fs)', icon: <FilesystemIcon size={19} /> },
  { id: 'sync', label: 'Process sync', accent: 'var(--accent-sync)', icon: <SyncIcon size={19} /> },
  { id: 'network', label: 'Network', accent: 'var(--accent-network)', icon: <NetworkIcon size={19} /> },
  { id: 'terminal', label: 'Terminal', accent: 'var(--accent-terminal)', icon: <TerminalIcon size={19} /> },
  { id: 'syscalls', label: 'Syscall trace', accent: 'var(--accent-syscall)', icon: <TraceIcon size={19} /> },
]

export function Dock() {
  const windows = useSimStore((s) => s.windows)
  const openWindow = useSimStore((s) => s.openWindow)

  return (
    <div className="dock">
      {DOCK_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`dock-item${windows[item.id].open ? '' : ' inactive'}`}
          style={{ '--dock-accent': item.accent } as React.CSSProperties}
          onClick={() => openWindow(item.id)}
          title={item.label}
          aria-label={`Open ${item.label} window`}
        >
          <div className="dock-icon">{item.icon}</div>
          <span className={`dock-dot${windows[item.id].open ? ' on' : ''}`} />
        </button>
      ))}
    </div>
  )
}
