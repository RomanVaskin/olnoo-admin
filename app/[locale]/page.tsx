import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { isLocale } from '@/lib/i18n'
import { AppShell } from '@/components/app-shell'

export default async function LocalePage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  if (!isLocale(locale)) notFound()

  return (
    <Suspense fallback={null}>
      <AppShell />
    </Suspense>
  )
}
