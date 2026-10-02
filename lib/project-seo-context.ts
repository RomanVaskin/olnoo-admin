import type { Pool } from 'pg'
import { normalizeSeoContext, type SeoContext } from './keywords-relevance-rules.ts'

// Explicit SEO context of a project (project_seo_context, one row per project, free text edited in
// SEO Admin). It is the authoritative input of the AI query cleanup; existing pages are only extra facts.

export class SeoContextError extends Error {}

/** Postgres "undefined_table": the migration (0013) has not been applied yet — treated as "no context". */
const UNDEFINED_TABLE = '42P01'

/** The project's SEO context, or null when none was saved (or the table does not exist yet). */
export async function getProjectSeoContext(pool: Pool, projectId: number): Promise<SeoContext | null> {
  try {
    const { rows } = await pool.query(
      `SELECT business_type, region, services, planned_services, excluded FROM project_seo_context WHERE project_id = $1`,
      [projectId],
    )
    const r = rows[0]
    return r ? { businessType: r.business_type, region: r.region, services: r.services, plannedServices: r.planned_services, excluded: r.excluded } : null
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) return null
    throw err
  }
}

/** Saves (replaces) the project's SEO context. Fields are trimmed and length-capped. */
export async function saveProjectSeoContext(pool: Pool, projectId: number, input: unknown): Promise<SeoContext> {
  const ctx = normalizeSeoContext(input)
  const { rows } = await pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId])
  if (!rows[0]) throw new SeoContextError('Неизвестный проект')
  try {
    await pool.query(
      `INSERT INTO project_seo_context (project_id, business_type, region, services, planned_services, excluded, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (project_id) DO UPDATE SET business_type = EXCLUDED.business_type, region = EXCLUDED.region,
         services = EXCLUDED.services, planned_services = EXCLUDED.planned_services, excluded = EXCLUDED.excluded, updated_at = now()`,
      [projectId, ctx.businessType, ctx.region, ctx.services, ctx.plannedServices, ctx.excluded],
    )
  } catch (err) {
    if ((err as { code?: string }).code === UNDEFINED_TABLE) throw new SeoContextError('Таблица project_seo_context не создана — примените миграцию 0013.')
    throw err
  }
  return ctx
}
