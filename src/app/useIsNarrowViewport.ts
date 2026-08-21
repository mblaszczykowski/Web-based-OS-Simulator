import { useEffect, useState } from 'react'

// Split out from SmallScreenNotice.tsx so that component file only exports
// a component (react-refresh/only-export-components) — this is the reusable hook half.

/** Below this width the desktop metaphor (overlapping draggable windows) stops making sense — see SmallScreenNotice.tsx. */
export const SMALL_SCREEN_BREAKPOINT_PX = 860

function supportsMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/** Tracks whether the viewport is currently narrower than `breakpointPx`, live across resizes/rotation. */
export function useIsNarrowViewport(breakpointPx: number): boolean {
  const query = `(max-width: ${breakpointPx}px)`
  const [isNarrow, setIsNarrow] = useState(() => (supportsMatchMedia() ? window.matchMedia(query).matches : false))

  useEffect(() => {
    if (!supportsMatchMedia()) return
    const mql = window.matchMedia(query)
    const handleChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches)
    setIsNarrow(mql.matches) // the query string itself can change between renders
    mql.addEventListener('change', handleChange)
    return () => mql.removeEventListener('change', handleChange)
  }, [query])

  return isNarrow
}
