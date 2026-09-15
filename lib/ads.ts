import { randomUUID } from 'node:crypto'
import { pool } from '@/lib/db'
import { resolveProjectId } from '@/lib/crm'

const KNOWN_PLATFORMS = ['yandex_direct', 'google_ads', 'vk_ads', 'meta_ads', 'telegram_ads'] as const
export type AdsPlatform = (typeof KNOWN_PLATFORMS)[number]

export function isAdsPlatform(value: unknown): value is AdsPlatform {
  return typeof value === 'string' && (KNOWN_PLATFORMS as readonly string[]).includes(value)
}

const KNOWN_STATUSES = ['draft', 'active', 'paused', 'completed'] as const
export type AdsStatus = (typeof KNOWN_STATUSES)[number]

export function isAdsStatus(value: unknown): value is AdsStatus {
  return typeof value === 'string' && (KNOWN_STATUSES as readonly string[]).includes(value)
}

export type AdsCampaignFields = {
  platform: string
  name?: string
  status?: string
  budget?: number
  spend?: number
  impressions?: number
  clicks?: number
  leads?: number
  sales?: number
  revenue?: number
  utmSource?: string
  utmMedium?: string
  utmCampaign?: string
  startedAt?: string
  endedAt?: string
}

export type AdsCampaignResult = { error: string; status: number } | { row: Record<string, unknown> }

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** All operations are project-scoped: every query filters by project_id, resolved from the
 * caller-supplied slug — a campaign id from another project can never be read, edited, or deleted
 * by supplying a different id with this project's slug (or vice versa). No "all projects"
 * aggregate view — Ads campaigns, like Social posts/accounts, only ever make sense within one
 * project. */

export async function listAdsCampaigns(
  projectSlug: string | null,
  filters: { platform?: string; status?: string } = {},
): Promise<Record<string, unknown>[] | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null

  const clauses = ['project_id = $1']
  const params: unknown[] = [projectId]

  if (filters.platform && isAdsPlatform(filters.platform)) {
    params.push(filters.platform)
    clauses.push(`platform = $${params.length}`)
  }
  if (filters.status && isAdsStatus(filters.status)) {
    params.push(filters.status)
    clauses.push(`status = $${params.length}`)
  }

  const { rows } = await pool.query(
    `SELECT * FROM ads_campaigns WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
    params,
  )
  return rows
}

export async function getAdsCampaign(id: string, projectSlug: string | null): Promise<Record<string, unknown> | null> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return null
  const { rows } = await pool.query('SELECT * FROM ads_campaigns WHERE id = $1 AND project_id = $2', [id, projectId])
  return rows[0] ?? null
}

export async function createAdsCampaign(
  projectSlug: string | null,
  input: AdsCampaignFields,
): Promise<AdsCampaignResult> {
  if (!isAdsPlatform(input.platform)) return { error: 'a known platform is required', status: 400 }
  if (input.status && !isAdsStatus(input.status)) return { error: 'invalid status', status: 400 }

  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const id = randomUUID()
  const { rows } = await pool.query(
    `
    INSERT INTO ads_campaigns (
      id, project_id, platform, name, status, budget, spend, impressions, clicks, leads, sales,
      revenue, utm_source, utm_medium, utm_campaign, started_at, ended_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
    RETURNING *
    `,
    [
      id,
      projectId,
      input.platform,
      (input.name ?? '').trim(),
      input.status ?? 'draft',
      toNumber(input.budget, 0),
      toNumber(input.spend, 0),
      toNumber(input.impressions, 0),
      toNumber(input.clicks, 0),
      toNumber(input.leads, 0),
      toNumber(input.sales, 0),
      toNumber(input.revenue, 0),
      (input.utmSource ?? '').trim(),
      (input.utmMedium ?? '').trim(),
      (input.utmCampaign ?? '').trim(),
      (input.startedAt ?? '').trim(),
      (input.endedAt ?? '').trim(),
    ],
  )
  return { row: rows[0] }
}

export async function updateAdsCampaign(
  id: string,
  projectSlug: string | null,
  input: Partial<AdsCampaignFields>,
): Promise<AdsCampaignResult> {
  if (input.platform !== undefined && !isAdsPlatform(input.platform)) {
    return { error: 'a known platform is required', status: 400 }
  }
  if (input.status && !isAdsStatus(input.status)) return { error: 'invalid status', status: 400 }

  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return { error: 'a known project is required', status: 400 }

  const sets: string[] = []
  const params: unknown[] = []
  let i = 1

  function set(column: string, value: unknown) {
    sets.push(`${column} = $${i}`)
    params.push(value)
    i++
  }

  if (input.platform !== undefined) set('platform', input.platform)
  if (typeof input.name === 'string') set('name', input.name.trim())
  if (input.status) set('status', input.status)
  if (input.budget !== undefined) set('budget', toNumber(input.budget, 0))
  if (input.spend !== undefined) set('spend', toNumber(input.spend, 0))
  if (input.impressions !== undefined) set('impressions', toNumber(input.impressions, 0))
  if (input.clicks !== undefined) set('clicks', toNumber(input.clicks, 0))
  if (input.leads !== undefined) set('leads', toNumber(input.leads, 0))
  if (input.sales !== undefined) set('sales', toNumber(input.sales, 0))
  if (input.revenue !== undefined) set('revenue', toNumber(input.revenue, 0))
  if (typeof input.utmSource === 'string') set('utm_source', input.utmSource.trim())
  if (typeof input.utmMedium === 'string') set('utm_medium', input.utmMedium.trim())
  if (typeof input.utmCampaign === 'string') set('utm_campaign', input.utmCampaign.trim())
  if (typeof input.startedAt === 'string') set('started_at', input.startedAt.trim())
  if (typeof input.endedAt === 'string') set('ended_at', input.endedAt.trim())

  if (!sets.length) {
    const existing = await getAdsCampaign(id, projectSlug)
    if (!existing) return { error: 'not found', status: 404 }
    return { row: existing }
  }

  sets.push('updated_at = now()')
  params.push(id, projectId)

  const { rows } = await pool.query(
    `UPDATE ads_campaigns SET ${sets.join(', ')} WHERE id = $${i} AND project_id = $${i + 1} RETURNING *`,
    params,
  )
  if (!rows[0]) return { error: 'not found', status: 404 }
  return { row: rows[0] }
}

export async function deleteAdsCampaign(id: string, projectSlug: string | null): Promise<boolean> {
  const projectId = await resolveProjectId(projectSlug)
  if (!projectId) return false
  const { rowCount } = await pool.query('DELETE FROM ads_campaigns WHERE id = $1 AND project_id = $2', [id, projectId])
  return (rowCount ?? 0) > 0
}
