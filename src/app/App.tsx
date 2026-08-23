import { useEffect, useRef, useState } from 'react'
import { Desktop } from './Desktop'
import { useSimStore } from './store'
import { hydrateAndBootstrap, resetSync } from './engines'
import { BootScreen, BOOT_DURATION_MS } from './BootScreen'
import { SmallScreenNotice } from './SmallScreenNotice'
import { useIsNarrowViewport, SMALL_SCREEN_BREAKPOINT_PX } from './useIsNarrowViewport'
import { readSharedSessionState } from './urlState'

const TICK_INTERVAL_MS = 450

export function App() {
  const running = useSimStore((s) => s.running)
  const stepOnce = useSimStore((s) => s.stepOnce)
  const bootstrapped = useRef(false)
  const [ready, setReady] = useState(false)
  const isNarrow = useIsNarrowViewport(SMALL_SCREEN_BREAKPOINT_PX)

  useEffect(() => {
    if (isNarrow) return
    if (bootstrapped.current) return
    bootstrapped.current = true
    const cosmetic = new Promise<void>((resolve) => window.setTimeout(resolve, BOOT_DURATION_MS))
    Promise.all([hydrateAndBootstrap(), cosmetic])
      .catch((error: unknown) => {
        console.error('Boot sequence failed unexpectedly; continuing with default state.', error)
      })
      .then(() => {
        const shared = readSharedSessionState()
        if (shared.raceOn !== null) resetSync(shared.raceOn)
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
