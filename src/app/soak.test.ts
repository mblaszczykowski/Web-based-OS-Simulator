// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../shared/types'
import { scheduler, memory, filesystem, pipes, fdTable, stepSimulation } from './engines'
import { useSimStore } from './store'

describe('soak: the integrated simulator survives a long, busy run', () => {
  it('holds every cross-subsystem invariant over 3000 ticks of mixed load', () => {
    const run = useSimStore.getState().runCommand
    const commands = [
      'run compiler',
      'stress 4',
      'pipe producer consumer',
      'write /soak/log.txt hello',
      'cat /soak/log.txt',
      'ln -s /soak/log.txt /soak/link',
      'cat /soak/link',
      'run --threads=3 worker',
      'df',
      'lsof',
      'ls /soak',
      'rm /soak/link',
      'crash',
      'fsck',
    ]

    for (let tick = 0; tick < 3000; tick++) {
      if (tick % 97 === 0) run(commands[(tick / 97) % commands.length]!)
      if (tick % 211 === 0) {
        const victim = scheduler.getProcesses().find((p) => p.state !== 'TERMINATED')
        if (victim) run(`fork ${victim.pid}`)
      }
      if (tick % 307 === 0) {
        const victim = scheduler.getProcesses().find((p) => p.state !== 'TERMINATED')
        if (victim) run(`kill ${victim.pid}`)
      }
      stepSimulation()

      const queued = scheduler.cores.flatMap((core) => scheduler.getReadyQueues(core).flat().map((p) => p.pid))
      expect(new Set(queued).size).toBe(queued.length)
      const onCpu = scheduler.getRunningProcesses().filter((p): p is NonNullable<typeof p> => p !== undefined)
      expect(new Set(onCpu.map((p) => p.pid)).size).toBe(onCpu.length)
      for (const p of onCpu) expect(queued).not.toContain(p.pid)

      for (const frame of memory.getFrames()) {
        if (!frame.owner) {
          expect(frame.shares).toHaveLength(0)
          continue
        }
        for (const mapping of [frame.owner, ...frame.shares]) {
          if (mapping.pid === 0) continue
          const entry = memory.getPageTable(mapping.pid)?.[mapping.page]
          expect(entry?.valid).toBe(true)
          expect(entry?.frame).toBe(frame.index)
        }
      }

      const dirs: DirEntry[] = [filesystem.getTree()]
      while (dirs.length > 0) {
        const dir = dirs.pop()!
        const names = (dir.children ?? []).map((c) => c.name)
        expect(new Set(names).size).toBe(names.length)
        for (const child of dir.children ?? []) if (child.type === 'dir') dirs.push(child)
      }

      const bitmap = filesystem.getFreeSpaceBitmap()
      const blocks = filesystem.getBlocks()
      expect(bitmap.length).toBe(blocks.length)
      for (let i = 0; i < bitmap.length; i++) expect(bitmap[i]).toBe(blocks[i]!.owner !== null)
    }

    const pendingWaiters = new Set(
      filesystem.getIoState().pending.flatMap((r) => (r.waiterPid === undefined ? [] : [r.waiterPid])),
    )
    for (const p of scheduler.getProcesses()) {
      if (p.blockedOn === 'device') expect(pendingWaiters.has(p.pid)).toBe(true)
      if (p.blockedOn === 'pipe') {
        expect(pipes.getPipes().some((pipe) => pipe.writerPid === p.pid || pipe.readerPid === p.pid)).toBe(true)
      }
    }

    const live = new Set(scheduler.getProcesses().filter((p) => p.state !== 'TERMINATED').map((p) => p.pid))
    for (const descriptor of fdTable.all()) {
      if (descriptor.pid < 0) continue
      expect(live.has(descriptor.pid)).toBe(true)
    }

    expect(scheduler.getMetrics().completed).toBeGreaterThan(5)
  }, 60_000)
})
