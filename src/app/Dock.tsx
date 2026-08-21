import { useSimStore, type WindowId } from './store'
import { SchedulerIcon, MemoryIcon, FilesystemIcon, TerminalIcon } from './icons'

const DOCK_ITEMS: { id: WindowId; accent: string; icon: React.ReactNode }[] = [
  { id: 'scheduler', accent: 'var(--accent-scheduler)', icon: <SchedulerIcon size={19} /> },
  { id: 'memory', accent: 'var(--accent-memory)', icon: <MemoryIcon size={19} /> },
  { id: 'filesystem', accent: 'var(--accent-fs)', icon: <FilesystemIcon size={19} /> },
  { id: 'terminal', accent: 'var(--accent-terminal)', icon: <TerminalIcon size={19} /> },
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
          title={item.id}
        >
          <div className="dock-icon">{item.icon}</div>
          <span className={`dock-dot${windows[item.id].open ? ' on' : ''}`} />
        </button>
      ))}
    </div>
  )
}
