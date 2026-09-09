import { randomUUID } from 'node:crypto'
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
  email: string
  company?: string
  service?: string
  message?: string
  source?: string
  notes?: string
}

export type CreateLeadResult = { error: string; status: number } | { row: Record<string, unknown> }

/** Shared insert used by both the Admin UI's create form and the authenticated inbound API. */
export async function createLeadRecord(input: CreateLeadInput): Promise<CreateLeadResult> {
  if (!input.name.trim()) return { error: 'name is required', status: 400 }
  if (!/^\S+@\S+\.\S+$/.test(input.email)) return { error: 'a valid email is required', status: 400 }

  const projectId = await resolveProjectId(input.project)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const id = randomUUID()
  const { rows } = await pool.query(
    `
    INSERT INTO leads (
      id, project_id, name, company, email, service, message, source, status, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'New', $9)
    RETURNING *
    `,
    [
      id,
      projectId,
      input.name.trim(),
      (input.company ?? '').trim(),
      input.email.trim(),
      (input.service ?? '').trim(),
      input.message ?? '',
      normalizeSource(input.source),
      input.notes ?? '',
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
