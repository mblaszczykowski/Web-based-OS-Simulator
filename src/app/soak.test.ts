// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { DirEntry } from '../shared/types'
import { scheduler, memory, filesystem, pipes, fdTable, stepSimulation } from './engines'
import { useSimStore } from './store'

// A soak run over the fully-integrated system: every subsystem the phase
// touched, driven together for thousands of ticks with commands
// interleaved. Not a substitute for the targeted tests — it can only
// catch invariants that break *somewhere* — but it is the only thing that
// exercises scheduler + disk + memory + pipes + fd table at once, which
// is exactly where a wiring mistake between two of them would hide.
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

      // --- scheduler: no process is ever queued twice, or on two CPUs ---
      const queued = scheduler.cores.flatMap((core) => scheduler.getReadyQueues(core).flat().map((p) => p.pid))
      expect(new Set(queued).size).toBe(queued.length)
      const onCpu = scheduler.getRunningProcesses().filter((p): p is NonNullable<typeof p> => p !== undefined)
      expect(new Set(onCpu.map((p) => p.pid)).size).toBe(onCpu.length)
      // A running process is never simultaneously sitting in a queue.
      for (const p of onCpu) expect(queued).not.toContain(p.pid)

      // --- memory: every frame mapping is live and points back here ---
      for (const frame of memory.getFrames()) {
        if (!frame.owner) {
          expect(frame.shares).toHaveLength(0)
          continue
        }
        for (const mapping of [frame.owner, ...frame.shares]) {
          if (mapping.pid === 0) continue // kernel-reserved
          const entry = memory.getPageTable(mapping.pid)?.[mapping.page]
          expect(entry?.valid).toBe(true)
          expect(entry?.frame).toBe(frame.index)
        }
      }

      // --- filesystem: no directory ever holds two entries of the same
      //     name. Every way of corrupting the tree that has actually been
      //     found so far (a replayed `write` landing on a path that is
      //     really a directory, or a symlink — see applyCreate) shows up
      //     as exactly this. Worth asserting continuously even though the
      //     known cases have their own targeted tests, because the
      //     dangerous property of that class of bug is that nothing else
      //     notices: the tree keeps working, one entry just becomes
      //     permanently unreachable.
      //
      //     Note this soak run does NOT reproduce the ln -s case on its
      //     own — swap writes reset lastTouchedPath constantly, so by the
      //     time `crash` runs it points at a /swap file. Checked by
      //     reverting the fix and confirming this still passes.
      const dirs: DirEntry[] = [filesystem.getTree()]
      while (dirs.length > 0) {
        const dir = dirs.pop()!
        const names = (dir.children ?? []).map((c) => c.name)
        expect(new Set(names).size).toBe(names.length)
        for (const child of dir.children ?? []) if (child.type === 'dir') dirs.push(child)
      }

      // --- filesystem: the bitmap and the block owners never disagree ---
      const bitmap = filesystem.getFreeSpaceBitmap()
      const blocks = filesystem.getBlocks()
      expect(bitmap.length).toBe(blocks.length)
      for (let i = 0; i < bitmap.length; i++) expect(bitmap[i]).toBe(blocks[i]!.owner !== null)
    }

    // --- nothing is stranded ---
    // Every process blocked on the disk still has a request queued for it;
    // otherwise it is waiting for a completion that can never arrive.
    const pendingWaiters = new Set(
      filesystem.getIoState().pending.flatMap((r) => (r.waiterPid === undefined ? [] : [r.waiterPid])),
    )
    for (const p of scheduler.getProcesses()) {
      if (p.blockedOn === 'device') expect(pendingWaiters.has(p.pid)).toBe(true)
      // Every process blocked on a pipe still holds an open end of one.
      if (p.blockedOn === 'pipe') {
        expect(pipes.getPipes().some((pipe) => pipe.writerPid === p.pid || pipe.readerPid === p.pid)).toBe(true)
      }
    }

    // --- no descriptor outlives the process that opened it ---
    const live = new Set(scheduler.getProcesses().filter((p) => p.state !== 'TERMINATED').map((p) => p.pid))
    for (const descriptor of fdTable.all()) {
      if (descriptor.pid < 0) continue // the shell's pseudo-pid
      expect(live.has(descriptor.pid)).toBe(true)
    }

    // And the run really was busy, rather than quietly stalling early.
    expect(scheduler.getMetrics().completed).toBeGreaterThan(5)
  }, 60_000)
})
