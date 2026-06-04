'use client'

import { useEffect, useState, useCallback } from 'react'

/**
 * SSR-safe localStorage hook. Reads after mount to avoid hydration mismatch.
 */
export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(initial)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      if (raw !== null) {
        setValue(JSON.parse(raw) as T)
      }
    } catch {
      /* corrupt or unavailable */
    }
    setHydrated(true)
  }, [key])

  const set = useCallback((v: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      try {
        if (hydrated) localStorage.setItem(key, JSON.stringify(next))
      } catch {
        /* quota or disabled */
      }
      return next
    })
  }, [key, hydrated])

  return [value, set]
}
