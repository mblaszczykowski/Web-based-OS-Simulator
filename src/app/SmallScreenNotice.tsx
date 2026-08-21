import { LogoIcon } from './icons'
import { SMALL_SCREEN_BREAKPOINT_PX } from './useIsNarrowViewport'

// Small-screen fallback — roadmap-v3.md §2.6. `.app-root` has a hard
// `min-width: 1100px` (the desktop metaphor doesn't degrade gracefully —
// overlapping draggable windows have nowhere sensible to go on a phone
// screen); without this, opening the live demo link on a phone just shows
// a horizontally-clipped mess. Below the breakpoint (see
// useIsNarrowViewport.ts) App.tsx skips the boot sequence and desktop
// entirely and renders this instead.
export function SmallScreenNotice() {
  return (
    <div className="small-screen-notice" role="status">
      <div className="small-screen-brand">
        <LogoIcon />
        OS.SIM
      </div>
      <p>This demo simulates a desktop with draggable, resizable windows — it needs a bigger screen to make sense.</p>
      <p className="small-screen-hint">Reopen it on a laptop or desktop browser, at least {SMALL_SCREEN_BREAKPOINT_PX}px wide.</p>
    </div>
  )
}
