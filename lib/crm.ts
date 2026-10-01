import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { pool } from '@/lib/db'

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
}

export type CreateLeadResult = { error: string; status: number } | { row: Record<string, unknown> }

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

  const projectId = await resolveProjectId(input.project)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const id = randomUUID()
  const { rows } = await db.query(
    `
    INSERT INTO leads (
      id, project_id, name, company, email, service, message, source, status, notes,
      phone, contact, landing_page, page_path, referrer, locale,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'New', $9,
      $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
    RETURNING *
    `,
    [
      id,
      projectId,
      input.name.trim(),
      (input.company ?? '').trim(),
      email,
      (input.service ?? '').trim(),
      input.message ?? '',
      normalizeSource(input.source),
      input.notes ?? '',
      phone || null,
      contact || null,
      input.pageUrl ?? '',
      input.pagePath ?? '',
      input.referrer ?? '',
      input.locale ?? '',
      input.utmSource ?? '',
      input.utmMedium ?? '',
      input.utmCampaign ?? '',
      input.utmContent ?? '',
      input.utmTerm ?? '',
    ],
  )
  return { row: rows[0] }
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
