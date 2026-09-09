import { pool } from '@/lib/db'

/** Resolves a URL-facing project slug (e.g. "olnoo") to the numeric projects.id, or null for "all"/unknown. */
export async function resolveProjectId(slug: string | null): Promise<number | null> {
  if (!slug || slug === 'all') return null
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM projects WHERE slug = $1', [slug])
  return rows[0]?.id ?? null
}

const KNOWN_SOURCES = ['SEO', 'Ads', 'Telegram', 'Direct', 'Referral'] as const
export type LeadSource = (typeof KNOWN_SOURCES)[number]

/** Buckets a free-form value (e.g. a raw utm_source) into the CRM's fixed source vocabulary. */
export function normalizeSource(value: string | null | undefined): LeadSource {
  const v = (value ?? '').trim().toLowerCase()
  if (!v) return 'Direct'
  if ((KNOWN_SOURCES as readonly string[]).includes(value as string)) return value as LeadSource
  if (v.includes('telegram')) return 'Telegram'
  if (v.includes('referral') || v.includes('referrer')) return 'Referral'
  if (v.includes('ads') || v.includes('cpc') || v.includes('yandex-direct') || v.includes('google-ads')) return 'Ads'
  if (v.includes('seo') || v.includes('organic')) return 'SEO'
  return 'Direct'
}

const KNOWN_STATUSES = ['New', 'In progress', 'Proposal', 'Won', 'Lost'] as const
export type LeadStatus = (typeof KNOWN_STATUSES)[number]

export function isLeadStatus(value: unknown): value is LeadStatus {
  return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)
}
