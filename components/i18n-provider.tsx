'use client'

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { messages, type Locale, type Messages } from '@/lib/i18n'

type I18nContextValue = {
  locale: Locale
  t: Messages
}

const I18nContext = createContext<I18nContextValue | null>(null)

export function I18nProvider({
  locale,
  children,
}: {
  locale: Locale
  children: ReactNode
}) {
  const value = useMemo<I18nContextValue>(
    () => ({ locale, t: messages[locale] }),
    [locale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const ctx = useContext(I18nContext)
  if (!ctx) {
    throw new Error('useI18n must be used within an I18nProvider')
  }
  return ctx
}
