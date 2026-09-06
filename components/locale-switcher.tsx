'use client'

import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { LOCALES } from '@/lib/i18n'
import { useI18n } from '@/components/i18n-provider'

export function LocaleSwitcher() {
  const { locale } = useI18n()
  const searchParams = useSearchParams()
  const query = Object.fromEntries(searchParams.entries())

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Language">
      {LOCALES.map((l) => (
        <Link
          key={l}
          href={{ pathname: `/${l}`, query }}
          scroll={false}
          className={`label-mono px-2 py-1 uppercase transition-colors ${
            locale === l
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
          aria-current={locale === l ? 'true' : undefined}
        >
          {l}
        </Link>
      ))}
    </div>
  )
}
