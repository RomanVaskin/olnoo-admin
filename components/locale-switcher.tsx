'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { LOCALES, type Locale } from '@/lib/i18n'
import { useI18n } from '@/components/i18n-provider'

export function LocaleSwitcher() {
  const { locale } = useI18n()
  const router = useRouter()
  const searchParams = useSearchParams()
  const queryString = searchParams.toString()

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>, target: Locale) {
    if (target === locale) return
    // Let modified/non-primary clicks (open in new tab, etc.) fall through to the plain href below.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    // Read the live address bar rather than the searchParams snapshot above — this is the same
    // data in the common case, but reading it fresh at the moment of the click guarantees an
    // existing param (screen, project, ...) can never be dropped by a stale snapshot.
    const liveSearch = typeof window !== 'undefined' ? window.location.search : queryString ? `?${queryString}` : ''
    router.push(`/${target}${liveSearch}`, { scroll: false })
  }

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Language">
      {LOCALES.map((l) => (
        <a
          key={l}
          href={`/${l}${queryString ? `?${queryString}` : ''}`}
          onClick={(e) => handleClick(e, l)}
          className={`label-mono px-2 py-1 uppercase transition-colors ${
            locale === l
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          aria-current={locale === l ? 'true' : undefined}
        >
          {l}
        </a>
      ))}
    </div>
  )
}
