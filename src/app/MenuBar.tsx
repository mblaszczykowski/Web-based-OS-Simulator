import { useSimStore } from './store'
import { memory, scheduler } from './engines'
import { CpuIcon, LogoIcon, MemChipIcon, PauseIcon, PlayIcon } from './icons'

export function MenuBar() {
  const running = useSimStore((s) => s.running)
  const toggleRunning = useSimStore((s) => s.toggleRunning)
  const tick = useSimStore((s) => s.tick)
  const demo = useSimStore((s) => s.demo)
  const startDemo = useSimStore((s) => s.startDemo)
  const stopDemo = useSimStore((s) => s.stopDemo)
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
        <button
          type="button"
          className={`menubar-demo-btn${demo.active ? ' active' : ''}`}
          onClick={demo.active ? stopDemo : startDemo}
          aria-label={demo.active ? 'Stop watch demo' : 'Watch a scripted demo of every subsystem'}
          title={demo.active ? 'Stop the running demo' : 'Watch a scripted tour of every subsystem'}
        >
          {demo.active ? '■ Stop demo' : '▶ Watch demo'}
        </button>
        <span className="menubar-stat">
          <CpuIcon size={13} />
          CPU <strong>{cpu}%</strong>
        </span>
        <span className="menubar-stat">
          <MemChipIcon size={13} />
          MEM <strong>{mem}%</strong>
        </span>
        <span className="menubar-sep" />
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
