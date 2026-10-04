// The INSERT behind createLeadRecord, kept free of `@/` imports so it can be tested against a real
// Postgres. One responsibility: store a lead, and make a replayed lead_tracking_id idempotent.

import type { Pool, PoolClient } from 'pg'
import type { LeadAttribution } from './lead-attribution.ts'

export type LeadRow = {
  id: string
  projectId: number
  name: string
  company: string
  email: string
  service: string
  message: string
  /** Already normalised to the CRM source vocabulary. */
  source: string
  notes: string
  phone: string | null
  contact: string | null
  landingPage: string
  pagePath: string
  referrer: string
  locale: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  utmContent: string
  utmTerm: string
  attribution: LeadAttribution
}

export type InsertLeadResult =
  | { row: Record<string, unknown>; replay: boolean }
  | { error: string; status: number }

/**
 * Inserts the lead. If `attribution.leadTrackingId` already exists the new row is NOT created and the existing
 * lead is returned with `replay: true` (nothing is updated) — but only when it belongs to the same project;
 * an id that belongs to another project is a conflict and returns no lead data.
 */
export async function insertLead(db: Pick<Pool | PoolClient, 'query'>, lead: LeadRow): Promise<InsertLeadResult> {
  const a = lead.attribution
  const { rows } = await db.query(
    `
    INSERT INTO leads (
      id, project_id, name, company, email, service, message, source, status, notes,
      phone, contact, landing_page, page_path, referrer, locale,
      utm_source, utm_medium, utm_campaign, utm_content, utm_term,
      lead_tracking_id, metrika_client_id, yclid, first_seen_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'New', $9,
      $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24::timestamptz)
    ON CONFLICT (lead_tracking_id) WHERE lead_tracking_id IS NOT NULL DO NOTHING
    RETURNING *
    `,
    [
      lead.id, lead.projectId, lead.name, lead.company, lead.email, lead.service, lead.message, lead.source, lead.notes,
      lead.phone, lead.contact, lead.landingPage, lead.pagePath, lead.referrer, lead.locale,
      lead.utmSource, lead.utmMedium, lead.utmCampaign, lead.utmContent, lead.utmTerm,
      a.leadTrackingId, a.metrikaClientId, a.yclid, a.firstSeenAt,
    ],
  )
  if (rows[0]) return { row: rows[0], replay: false }

  // Only reachable with a lead_tracking_id: the id already exists.
  const existing = await db.query('SELECT * FROM leads WHERE lead_tracking_id = $1', [a.leadTrackingId])
  const row = existing.rows[0]
  if (!row) return { error: 'lead could not be stored', status: 500 }
  if (row.project_id !== lead.projectId) return { error: 'lead_tracking_id is already used', status: 409 }
  return { row, replay: true }
}
