import { useSimStore } from './store'

export function SkipLink() {
  const openWindow = useSimStore((s) => s.openWindow)

  function handleClick(e: React.MouseEvent) {
    e.preventDefault()
    openWindow('terminal')
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
