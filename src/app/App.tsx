import { useEffect, useRef } from 'react'
import { Desktop } from './Desktop'
import { useSimStore } from './store'
import { bootstrapWorkload } from './engines'

const TICK_INTERVAL_MS = 450

export function App() {
  const running = useSimStore((s) => s.running)
  const stepOnce = useSimStore((s) => s.stepOnce)
  const bootstrapped = useRef(false)

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    bootstrapWorkload()
    // Without this, the desktop would render empty for one full tick
    // interval before the bootstrapped processes/files ever show up.
    stepOnce()
  }, [stepOnce])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => stepOnce(), TICK_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [running, stepOnce])

  return <Desktop />
}
