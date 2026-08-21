import { useSimStore, type WindowId } from './store'
import { SchedulerIcon, MemoryIcon, FilesystemIcon, TerminalIcon, TraceIcon, SyncIcon, NetworkIcon } from './icons'

const DOCK_ITEMS: { id: WindowId; label: string; icon: React.ReactNode }[] = [
  { id: 'scheduler', label: 'Scheduler', icon: <SchedulerIcon size={19} /> },
  { id: 'memory', label: 'Memory', icon: <MemoryIcon size={19} /> },
  { id: 'filesystem', label: 'Filesystem', icon: <FilesystemIcon size={19} /> },
  { id: 'sync', label: 'Sync', icon: <SyncIcon size={19} /> },
  { id: 'network', label: 'Network', icon: <NetworkIcon size={19} /> },
  { id: 'terminal', label: 'Terminal', icon: <TerminalIcon size={19} /> },
  { id: 'syscalls', label: 'Trace', icon: <TraceIcon size={19} /> },
]

export function Dock() {
  const windows = useSimStore((s) => s.windows)
  const openWindow = useSimStore((s) => s.openWindow)
  const focusedWindow = useSimStore((s) => s.focusedWindow)

  return (
    <div className="dock">
      {DOCK_ITEMS.map((item) => {
        const open = windows[item.id].open
        const focused = open && focusedWindow === item.id
        return (
          <button
            key={item.id}
            type="button"
            className={`dock-item${open ? '' : ' inactive'}${focused ? ' focused' : ''}`}
            onClick={() => openWindow(item.id)}
            title={item.label}
            aria-label={`Open ${item.label} window`}
          >
            <div className="dock-icon">
              {item.icon}
              <span className={`dock-dot${open ? ' on' : ''}`} />
            </div>
            <span className="dock-label">{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
