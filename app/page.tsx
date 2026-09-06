import { redirect } from 'next/navigation'
import { headers } from 'next/headers'
import { pickLocaleFromAcceptLanguage } from '@/lib/i18n'

export default async function RootPage() {
  const headersList = await headers()
  const locale = pickLocaleFromAcceptLanguage(headersList.get('accept-language'))
  redirect(`/${locale}`)
}
