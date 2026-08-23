import { LogoIcon } from './icons'
import { SMALL_SCREEN_BREAKPOINT_PX } from './useIsNarrowViewport'

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
