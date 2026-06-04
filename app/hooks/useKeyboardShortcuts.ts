'use client'

import { useEffect, useRef } from 'react'

type Handler = (e: KeyboardEvent) => void
type Map = Record<string, Handler>

/**
 * Bind keyboard shortcuts. Supports single keys and two-key sequences (e.g. 'g d').
 * Ignores events from inputs / textareas / contenteditable.
 *
 * Uses a ref for the map so re-renders don't re-bind the listener or wipe sequence state.
 */
export function useKeyboardShortcuts(map: Map, enabled = true) {
  const mapRef = useRef<Map>(map)
  const seqRef = useRef<{ first: string | null; timer: ReturnType<typeof setTimeout> | null }>({
    first: null,
    timer: null,
  })

  // Keep ref in sync without re-running the listener effect
  useEffect(() => {
    mapRef.current = map
  })

  useEffect(() => {
    if (!enabled) return

    const isEditable = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false
      const tag = el.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (el.isContentEditable) return true
      return false
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isEditable(e.target) && e.key !== 'Escape') return

      const currentMap = mapRef.current
      const state = seqRef.current

      // Two-key sequence — second key
      if (state.first) {
        const combo = `${state.first} ${e.key.toLowerCase()}`
        if (state.timer) clearTimeout(state.timer)
        state.first = null
        state.timer = null
        const h = currentMap[combo]
        if (h) {
          e.preventDefault()
          h(e)
        }
        return
      }

      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const startsSequence = Object.keys(currentMap).some((k) => k.startsWith(`${key} `))
      if (startsSequence) {
        state.first = key
        state.timer = setTimeout(() => {
          state.first = null
          state.timer = null
        }, 800)
        return
      }

      const h = currentMap[key]
      if (h) {
        e.preventDefault()
        h(e)
      }
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (seqRef.current.timer) {
        clearTimeout(seqRef.current.timer)
        seqRef.current.first = null
        seqRef.current.timer = null
      }
    }
  }, [enabled])
}
