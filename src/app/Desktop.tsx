import { MenuBar } from './MenuBar'
import { Dock } from './Dock'
import { SchedulerWindow } from '../scheduler/SchedulerWindow'
import { MemoryWindow } from '../memory/MemoryWindow'
import { FilesystemWindow } from '../filesystem/FilesystemWindow'
import { TerminalWindow } from '../terminal/TerminalWindow'

export function Desktop() {
  return (
    <div className="app-root">
      <div className="blob blob--a" />
      <div className="blob blob--b" />
      <div className="blob blob--c" />

      <MenuBar />

      <SchedulerWindow />
      <MemoryWindow />
      <FilesystemWindow />
      <TerminalWindow />

      <Dock />
    </div>
  )
}
