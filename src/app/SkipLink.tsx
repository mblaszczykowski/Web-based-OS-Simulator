import { useSimStore } from './store'

/**
 * A plain `href="#terminal-input"` anchor silently stops working the
 * moment the Terminal window is closed (it's always closable via its
 * titlebar) — the fragment target just wouldn't exist. This opens the
 * window first, then focuses the input once it's actually mounted.
 */
export function SkipLink() {
  const openWindow = useSimStore((s) => s.openWindow)

  function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    openWindow('terminal')
    // openWindow's state update is flushed and re-rendered before the
    // next paint; requestAnimationFrame runs after that, once the input
    // is guaranteed to be in the DOM even if the window had been closed.
    requestAnimationFrame(() => {
      document.getElementById('terminal-input')?.focus()
    })
  }

  return (
    <a className="skip-link" href="#terminal-input" onClick={handleClick}>
      Skip to terminal
    </a>
  )
}
