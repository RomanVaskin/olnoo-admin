import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { parseLeadAttribution, type LeadAttributionInput } from './lead-attribution.ts'
import { insertLead } from './lead-insert.ts'

/** Resolves a URL-facing project slug (e.g. "olnoo") to the numeric projects.id, or null for "all"/unknown. */
export async function resolveProjectId(slug: string | null): Promise<number | null> {
  if (!slug || slug === 'all') return null
  const { rows } = await pool.query<{ id: number }>('SELECT id FROM projects WHERE slug = $1', [slug])
  return rows[0]?.id ?? null
}

export type CreateLeadInput = {
  project: string | null
  name: string
  email?: string
  phone?: string
  contact?: string
  pageUrl?: string
  pagePath?: string
  referrer?: string
  locale?: string
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  utmContent?: string
  utmTerm?: string
  company?: string
  service?: string
  message?: string
  source?: string
  notes?: string
  /** Optional attribution identifiers (validated here; absent/blank values are simply not stored). */
  attribution?: LeadAttributionInput
}

/** `replay: true` = the same lead_tracking_id was already stored; `row` is the existing lead and nothing was written. */
export type CreateLeadResult = { error: string; status: number } | { row: Record<string, unknown>; replay?: boolean }

/**
 * Shared insert used by the Admin UI's create form, the authenticated inbound API and the
 * Telegram Business webhook. `db` defaults to the pool; pass a transaction client to run the
 * insert inside a caller's transaction (the Telegram dedup lock).
 */
export async function createLeadRecord(input: CreateLeadInput, db: Pool | PoolClient = pool): Promise<CreateLeadResult> {
  if (!input.name.trim()) return { error: 'name is required', status: 400 }
  const email = (input.email ?? '').trim()
  const phone = (input.phone ?? '').trim()
  const contact = (input.contact ?? '').trim()
  if (!email && !phone && !contact) return { error: 'email, phone or contact is required', status: 400 }
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return { error: 'a valid email is required', status: 400 }

  const attribution = parseLeadAttribution(input.attribution ?? {})
  if ('error' in attribution) return attribution

  const projectId = await resolveProjectId(input.project)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const result = await insertLead(db, {
    id: randomUUID(),
    projectId,
    name: input.name.trim(),
    company: (input.company ?? '').trim(),
    email,
    service: (input.service ?? '').trim(),
    message: input.message ?? '',
    source: normalizeSource(input.source),
    notes: input.notes ?? '',
    phone: phone || null,
    contact: contact || null,
    landingPage: input.pageUrl ?? '',
    pagePath: input.pagePath ?? '',
    referrer: input.referrer ?? '',
    locale: input.locale ?? '',
    utmSource: input.utmSource ?? '',
    utmMedium: input.utmMedium ?? '',
    utmCampaign: input.utmCampaign ?? '',
    utmContent: input.utmContent ?? '',
    utmTerm: input.utmTerm ?? '',
    attribution,
  })
  if ('error' in result) return result
  return result.replay ? { row: result.row, replay: true } : { row: result.row }
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
