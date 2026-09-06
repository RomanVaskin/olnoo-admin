import { notFound } from 'next/navigation'
import { LOCALES, isLocale } from '@/lib/i18n'
import { I18nProvider } from '@/components/i18n-provider'
import { HtmlLangSync } from '@/components/html-lang-sync'

export function generateStaticParams() {
  return LOCALES.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()

  return (
    <I18nProvider locale={locale}>
      <HtmlLangSync locale={locale} />
      {children}
    </I18nProvider>
  )
}
