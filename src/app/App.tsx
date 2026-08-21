import { useEffect, useRef, useState } from 'react'
import { Desktop } from './Desktop'
import { useSimStore } from './store'
import { hydrateAndBootstrap } from './engines'
import { BootScreen, BOOT_DURATION_MS } from './BootScreen'
import { SmallScreenNotice } from './SmallScreenNotice'
import { useIsNarrowViewport, SMALL_SCREEN_BREAKPOINT_PX } from './useIsNarrowViewport'

const TICK_INTERVAL_MS = 450

export function App() {
  const running = useSimStore((s) => s.running)
  const stepOnce = useSimStore((s) => s.stepOnce)
  const bootstrapped = useRef(false)
  const [ready, setReady] = useState(false)
  const isNarrow = useIsNarrowViewport(SMALL_SCREEN_BREAKPOINT_PX)

  useEffect(() => {
    // Below the small-screen breakpoint we show SmallScreenNotice instead
    // of ever booting — without this guard, the boot/hydration work (and,
    // via `ready` below, the tick interval) ran anyway in the background
    // on a screen the user can't even see the result of, contradicting
    // SmallScreenNotice.tsx's own "skips the boot sequence and desktop
    // entirely" comment (found by code review). If the viewport later
    // widens past the breakpoint, this effect re-runs and boots normally.
    if (isNarrow) return
    if (bootstrapped.current) return
    bootstrapped.current = true
    // The boot animation is purely cosmetic (roadmap.md §1.2) and runs on
    // its own fixed timer; real filesystem hydration (§1.5) happens
    // concurrently. We wait for both so the desktop never mounts with a
    // half-loaded disk.
    const cosmetic = new Promise<void>((resolve) => window.setTimeout(resolve, BOOT_DURATION_MS))
    Promise.all([hydrateAndBootstrap(), cosmetic])
      .catch((error: unknown) => {
        // Should be unreachable — hydrateAndBootstrap()'s persistence step
        // is designed to never reject (a malformed disk falls back to a
        // fresh one; see FilesystemEngine.importState()). This is
        // defense-in-depth so a boot-time exception can never strand the
        // user on the boot screen forever, matching the same best-effort
        // philosophy applied one layer down.
        console.error('Boot sequence failed unexpectedly; continuing with default state.', error)
      })
      .then(() => {
        // Without this, the desktop would render empty for one full tick
        // interval before the bootstrapped processes/files ever show up.
        stepOnce()
        setReady(true)
      })
  }, [stepOnce, isNarrow])

  useEffect(() => {
    if (!running || !ready || isNarrow) return
    const id = window.setInterval(() => stepOnce(), TICK_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [running, ready, isNarrow, stepOnce])

  if (isNarrow) return <SmallScreenNotice />
  if (!ready) return <BootScreen />
  return <Desktop />
}
