import { MenuBar } from './MenuBar'
import { Dock } from './Dock'
import { SkipLink } from './SkipLink'
import { SchedulerWindow } from '../scheduler/SchedulerWindow'
import { MemoryWindow } from '../memory/MemoryWindow'
import { FilesystemWindow } from '../filesystem/FilesystemWindow'
import { TerminalWindow } from '../terminal/TerminalWindow'
import { SyscallWindow } from '../terminal/SyscallWindow'
import { SyncWindow } from '../sync/SyncWindow'
import { NetworkWindow } from '../network/NetworkWindow'

export function Desktop() {
  return (
    <div className="app-root">
      <SkipLink />

      <MenuBar />

      <SchedulerWindow />
      <MemoryWindow />
      <FilesystemWindow />
      <TerminalWindow />
      <SyscallWindow />
      <SyncWindow />
      <NetworkWindow />

      <Dock />
    </div>
  )
}
