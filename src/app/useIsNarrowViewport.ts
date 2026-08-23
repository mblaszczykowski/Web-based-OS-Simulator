import { useEffect, useState } from 'react'

export const SMALL_SCREEN_BREAKPOINT_PX = 860

function supportsMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

export function useIsNarrowViewport(breakpointPx: number): boolean {
  const query = `(max-width: ${breakpointPx}px)`
  const [isNarrow, setIsNarrow] = useState(() => (supportsMatchMedia() ? window.matchMedia(query).matches : false))

  useEffect(() => {
    if (!supportsMatchMedia()) return
    const mql = window.matchMedia(query)
    const handleChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches)
    setIsNarrow(mql.matches)
    mql.addEventListener('change', handleChange)
    return () => mql.removeEventListener('change', handleChange)
  }, [query])

  return isNarrow
}
