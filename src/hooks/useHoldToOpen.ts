import { useCallback, useEffect, useRef, type MouseEvent } from 'react'

const HOLD_MS = 1200

export function useHoldToOpen(onOpen: () => void, holdMs = HOLD_MS) {
  const timer = useRef<number | null>(null)

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }, [])

  const start = useCallback((event: { currentTarget: HTMLButtonElement; preventDefault: () => void }) => {
    // A sustained pointer press opens the modal before the browser's later
    // click step. Focus the real trigger now so modal focus restoration has a
    // stable target on touch devices and on platforms that do not focus
    // buttons during pointer-down by convention.
    // Prevent Safari's mousedown default from immediately moving focus back to
    // the body, which would fire onBlur and cancel an otherwise valid hold.
    event.preventDefault()
    try {
      event.currentTarget.focus({ preventScroll: true })
    } catch {
      // Older Safari/WebKit accepts focus() but rejects the options object.
      event.currentTarget.focus()
    }
    clear()
    timer.current = window.setTimeout(() => {
      timer.current = null
      onOpen()
    }, holdMs)
  }, [clear, holdMs, onOpen])

  // A released hold must never fire after unmount.
  useEffect(() => clear, [clear])

  return {
    onPointerDown: start,
    onMouseDown: start,
    onPointerUp: clear,
    onMouseUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    // Pointer clicks keep the accidental-activation guard: only the hold timer
    // opens settings. Native keyboard, switch, Voice Control and screen-reader
    // activation dispatch a click with detail=0 and must retain standard button
    // semantics rather than requiring an inaccessible sustained gesture.
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      clear()
      if (event.detail === 0) onOpen()
    },
    onBlur: clear,
  }
}
