export const LOCALES = ['ru', 'en'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

export function pickLocaleFromAcceptLanguage(header: string | null): Locale {
  if (!header) return DEFAULT_LOCALE

  const preferred = header
    .split(',')
    .map((part) => {
      const [tag, qPart] = part.trim().split(';q=')
      return { tag: tag.toLowerCase(), q: qPart ? parseFloat(qPart) : 1 }
    })
    .sort((a, b) => b.q - a.q)

  for (const { tag } of preferred) {
    if (tag.startsWith('ru')) return 'ru'
    if (tag.startsWith('en')) return 'en'
  }

  return DEFAULT_LOCALE
}

export function pluralRu(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return few
  return many
}

export function pluralizeProjects(n: number, locale: Locale): string {
  if (locale === 'ru') {
    return `${n} ${pluralRu(n, 'проект', 'проекта', 'проектов')}`
  }
  return `${n} project${n === 1 ? '' : 's'}`
}

export function pluralizeProperties(n: number, locale: Locale): string {
  if (locale === 'ru') {
    return `${n} ${pluralRu(n, 'проект', 'проекта', 'проектов')}`
  }
  return `${n} propert${n === 1 ? 'y' : 'ies'}`
}
