import type { Lead } from '@/lib/data'

/** Maps a /api/leads row (snake_case Postgres columns) to the UI's Lead shape. */
export function fromApiLead(row: Record<string, unknown>): Lead {
  return {
    id: row.id as string,
    name: row.name as string,
    company: (row.company as string) ?? '',
    email: row.email as string,
    service: (row.service as string) ?? '',
    source: row.source as Lead['source'],
    landingPage: (row.landing_page as string) ?? '',
    status: row.status as Lead['status'],
    created: new Date(row.created_at as string).toISOString().slice(0, 10),
    message: (row.message as string) ?? '',
    referrer: (row.referrer as string) ?? '',
    utmSource: (row.utm_source as string) ?? '',
    utmMedium: (row.utm_medium as string) ?? '',
    utmCampaign: (row.utm_campaign as string) ?? '',
    locale: (row.locale as string) ?? '',
    notes: (row.notes as string) ?? '',
    activity: [],
  }
}
