'use client'

import { useEffect } from 'react'

export function useDocumentTitle(title: string) {
  useEffect(() => {
    if (typeof document === 'undefined') return
    const prev = document.title
    document.title = title
    return () => {
      document.title = prev
    }
  }, [title])
}
