import { useSimStore } from './store'
import { memory, scheduler } from './engines'
import { LogoIcon, PauseIcon, PlayIcon } from './icons'

export function MenuBar() {
  const running = useSimStore((s) => s.running)
  const toggleRunning = useSimStore((s) => s.toggleRunning)
  const tick = useSimStore((s) => s.tick)
  useSimStore((s) => s.version) // subscribed purely so this bar re-renders on every tick/command

  const cpu = Math.round(scheduler.getMetrics().cpuUtilization * 100)
  const frames = memory.getFrames()
  const mem = frames.length ? Math.round((frames.filter((f) => f.owner !== null).length / frames.length) * 100) : 0

  return (
    <div className="menubar">
      <div className="menubar-left">
        <div className="menubar-brand">
          <LogoIcon />
          OS.SIM
        </div>
        <div className="menu-items">
          <span>File</span>
          <span>Edit</span>
          <span>View</span>
          <span>Help</span>
        </div>
      </div>
      <div className="menubar-right">
        <span>CPU {cpu}%</span>
        <span>MEM {mem}%</span>
        <button
          type="button"
          className="menubar-btn"
          onClick={toggleRunning}
          aria-label={running ? 'Pause simulation' : 'Resume simulation'}
          title={running ? 'Pause simulation' : 'Resume simulation'}
        >
          {running ? <PauseIcon /> : <PlayIcon />}
        </button>
        <span>
          Tick <strong>{tick}</strong>
        </span>
      </div>
    </div>
  )
}
