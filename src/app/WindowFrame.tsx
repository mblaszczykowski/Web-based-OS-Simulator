import { useRef, useState, type ReactNode } from 'react'
import { useSimStore, type WindowId } from './store'
import { MaximizeIcon, CloseIcon } from './icons'

interface WindowFrameProps {
  id: WindowId
  title: string
  subtitle?: string
  accent: string
  icon: ReactNode
  children: ReactNode
}

const MAXIMIZED_BOUNDS = { x: 24, y: 44, w: 'calc(100vw - 48px)', h: 'calc(100vh - 120px)' }
const MIN_WIDTH = 320
const MIN_HEIGHT = 200

export function WindowFrame({ id, title, subtitle, accent, icon, children }: WindowFrameProps) {
  const win = useSimStore((s) => s.windows[id])
  const focusedWindow = useSimStore((s) => s.focusedWindow)
  const focusWindow = useSimStore((s) => s.focusWindow)
  const closeWindow = useSimStore((s) => s.closeWindow)
  const moveWindow = useSimStore((s) => s.moveWindow)
  const resizeWindow = useSimStore((s) => s.resizeWindow)
  const [maximized, setMaximized] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null)
  const windowRef = useRef<HTMLDivElement>(null)

  if (!win.open) return null

  const MOVE_STEP = 10
  const MOVE_STEP_FAST = 30

  function handleTitlebarKeyDown(e: React.KeyboardEvent) {
    if (maximized) return
    const step = e.shiftKey ? MOVE_STEP_FAST : MOVE_STEP
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      moveWindow(id, win.x - step, win.y)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      moveWindow(id, win.x + step, win.y)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveWindow(id, win.x, win.y - step)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveWindow(id, win.x, win.y + step)
    }
  }

  // Tab/Shift+Tab wrap within this window's own focusable elements while
  // it's the focused window, instead of escaping into whatever window
  // happens to sit behind it in DOM order (roadmap.md §2.5).
  function handleWindowKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab' || focusedWindow !== id || !windowRef.current) return
    const focusable = windowRef.current.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    if (focusable.length === 0) return
    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  function handlePointerDown(e: React.PointerEvent) {
    // Focusing happens once, via the outer window's own onPointerDown
    // below (which this bubbles up to) — calling focusWindow(id) here too
    // would double-fire it on every titlebar click.
    if (maximized) return
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: win.x, origY: win.y }
    const onMove = (ev: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      moveWindow(id, drag.origX + (ev.clientX - drag.startX), drag.origY + (ev.clientY - drag.startY))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  function handleResizePointerDown(e: React.PointerEvent) {
    if (maximized) return
    e.stopPropagation()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, origW: win.w, origH: win.h }
    const onMove = (ev: PointerEvent) => {
      const resize = resizeRef.current
      if (!resize) return
      resizeWindow(
        id,
        Math.max(MIN_WIDTH, resize.origW + (ev.clientX - resize.startX)),
        Math.max(MIN_HEIGHT, resize.origH + (ev.clientY - resize.startY)),
      )
    }
    const onUp = () => {
      resizeRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const style = maximized
    ? { left: MAXIMIZED_BOUNDS.x, top: MAXIMIZED_BOUNDS.y, width: MAXIMIZED_BOUNDS.w, height: MAXIMIZED_BOUNDS.h }
    : { left: win.x, top: win.y, width: win.w, height: win.h }

  return (
    <div
      ref={windowRef}
      className={`window${focusedWindow === id ? ' focused' : ''}`}
      style={{ ...style, zIndex: win.zIndex, '--accent': accent } as unknown as React.CSSProperties}
      onPointerDown={() => focusWindow(id)}
      onKeyDown={handleWindowKeyDown}
      role="region"
      aria-label={`${title} window`}
    >
      <div
        className="titlebar"
        onPointerDown={handlePointerDown}
        tabIndex={0}
        onKeyDown={handleTitlebarKeyDown}
        aria-label={`${title} window titlebar — drag, or focus and use arrow keys, to move`}
      >
        <div className="win-icon">{icon}</div>
        <span className="win-title">{title}</span>
        {subtitle && <span className="win-sub">&middot; {subtitle}</span>}
        <div className="win-controls">
          <button
            type="button"
            className="win-ctrl-btn"
            aria-label="Maximize"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setMaximized((m) => !m)}
          >
            <MaximizeIcon />
          </button>
          <button
            type="button"
            className="win-ctrl-btn"
            aria-label="Close"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => closeWindow(id)}
          >
            <CloseIcon />
          </button>
        </div>
      </div>
      {children}
      {!maximized && (
        <div
          className="resize-handle"
          onPointerDown={handleResizePointerDown}
          role="presentation"
          aria-hidden="true"
        />
      )}
    </div>
  )
}
