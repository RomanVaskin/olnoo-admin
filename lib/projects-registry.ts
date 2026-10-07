// Project registry: `projects` is the single source of truth for the project list in the whole Admin.
// One reader (`listProjects`: active by default, archived only on an explicit request) and the write helpers behind the
// Projects screen (create / edit / archive / restore). No hard delete. Pure SQL helpers over an injectable `db`
// (no `@/` imports), so they run under `node --test`.
import { resolveSitemapUrl } from './sitemap.ts'

export type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

export type ArchivedFilter = 'exclude' | 'include' | 'only'

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const LOCALE_RE = /^[a-z]{2}(-[a-z]{2})?$/i
/** GitHub `owner/repo`: owner up to 39 chars (letters, digits, '-'), repo up to 100 (letters, digits, '.', '_', '-'). */
export const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/** Active projects: THE condition every project-based list/check must use (never a hand-written one). */
export const ACTIVE_PROJECT_SQL = 'pr.archived_at IS NULL'

const BASE_SELECT = `
  SELECT
    pr.id, pr.client_id, pr.name, pr.slug, pr.domain, pr.sitemap_url, pr.locale, pr.repository, pr.status,
    pr.last_sync_at, pr.created_at, pr.archived_at,
    c.name AS client_name,
    COALESCE(pg_count.count, 0)::int AS pages_count,
    COALESCE(kw_count.count, 0)::int AS keywords_count
  FROM projects pr
  JOIN clients c ON c.id = pr.client_id
  LEFT JOIN (SELECT project_id, COUNT(*) AS count FROM pages GROUP BY project_id) pg_count ON pg_count.project_id = pr.id
  LEFT JOIN (SELECT project_id, COUNT(*) AS count FROM keywords GROUP BY project_id) kw_count ON kw_count.project_id = pr.id`

/** Clients with the number of their ACTIVE projects (archived ones are not counted). */
export const CLIENTS_WITH_PROJECT_COUNT_SQL = `
  SELECT
    c.id,
    c.name,
    c.contact,
    c.status,
    c.created_at,
    COUNT(p.id)::int AS project_count
  FROM clients c
  LEFT JOIN projects p ON p.client_id = c.id AND p.archived_at IS NULL
  GROUP BY c.id
  ORDER BY c.created_at ASC, c.id ASC`

export type ProjectRow = {
  id: number
  client_id: number
  name: string
  slug: string | null
  domain: string
  sitemap_url: string
  locale: string | null
  repository: string | null
  status: string
  last_sync_at: string | null
  created_at: string
  archived_at: string | null
  client_name: string
  pages_count: number
  keywords_count: number
}

/** The ONE way to read projects. Active only unless the caller explicitly asks for archived ones. */
export async function listProjects(db: Queryable, opts: { archived?: ArchivedFilter } = {}): Promise<ProjectRow[]> {
  const archived = opts.archived ?? 'exclude'
  const where = archived === 'exclude' ? `WHERE ${ACTIVE_PROJECT_SQL}` : archived === 'only' ? 'WHERE pr.archived_at IS NOT NULL' : ''
  const { rows } = await db.query(`${BASE_SELECT} ${where} ORDER BY pr.created_at ASC, pr.id ASC`)
  return rows as ProjectRow[]
}

export async function getProject(db: Queryable, id: number): Promise<ProjectRow | null> {
  const { rows } = await db.query(`${BASE_SELECT} WHERE pr.id = $1`, [id])
  return (rows[0] as ProjectRow | undefined) ?? null
}

// ---- validation ---------------------------------------------------------------------------------------------------

export type ProjectInput = { name?: unknown; slug?: unknown; domain?: unknown; sitemapUrl?: unknown; locale?: unknown; repository?: unknown; clientId?: unknown }
export type ValidProject = { name: string; slug?: string; domain: string; sitemapUrl: string; locale: string | null; repository: string | null; clientId?: number }

export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

/** `https://host` (no path, no credentials) — the origin the site is checked and synced at. */
export function normalizeDomain(value: string): string | null {
  const raw = value.trim().replace(/\/+$/, '')
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || !u.hostname.includes('.')) return null
    return u.origin
  } catch {
    return null
  }
}

/** Create requires name + domain; slug defaults to the name; sitemap defaults to <domain>/sitemap.xml. */
export function validateProjectInput(input: ProjectInput): { ok: true; value: ValidProject } | { ok: false; error: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name || name.length > 120) return { ok: false, error: 'name is required (up to 120 characters)' }
  const domain = typeof input.domain === 'string' ? normalizeDomain(input.domain) : null
  if (!domain) return { ok: false, error: 'domain must be a site address like https://example.com' }
  let slug: string | undefined
  if (input.slug !== undefined && input.slug !== null && input.slug !== '') {
    if (typeof input.slug !== 'string' || !SLUG_RE.test(input.slug)) return { ok: false, error: 'slug must be lowercase letters, digits, "-" or "_"' }
    slug = input.slug
  } else {
    slug = slugify(name)
    if (!SLUG_RE.test(slug)) return { ok: false, error: 'slug is required (the name has no latin letters or digits)' }
  }
  let sitemapUrl: string | null
  if (typeof input.sitemapUrl === 'string' && input.sitemapUrl.trim()) {
    sitemapUrl = resolveSitemapUrl({ domain, sitemap_url: input.sitemapUrl })
    if (!sitemapUrl) return { ok: false, error: 'sitemapUrl must be an http(s) address' }
  } else sitemapUrl = resolveSitemapUrl({ domain, sitemap_url: '' })
  if (!sitemapUrl) return { ok: false, error: 'sitemapUrl could not be derived from the domain' }
  let locale: string | null = null
  if (input.locale !== undefined && input.locale !== null && input.locale !== '') {
    if (typeof input.locale !== 'string' || !LOCALE_RE.test(input.locale.trim())) return { ok: false, error: 'locale must look like "ru" or "en"' }
    locale = input.locale.trim().toLowerCase()
  }
  // Optional; empty = not set. Never derived from the domain/slug.
  let repository: string | null = null
  if (input.repository !== undefined && input.repository !== null && input.repository !== '') {
    const r = typeof input.repository === 'string' ? input.repository.trim() : null
    if (r === null) return { ok: false, error: 'repository must look like owner/repo (GitHub)' }
    if (r !== '') {
      if (!REPOSITORY_RE.test(r) || r.endsWith('.git') || r.split('/')[1] === '.' || r.split('/')[1] === '..') return { ok: false, error: 'repository must look like owner/repo (GitHub)' }
      repository = r
    }
  }
  let clientId: number | undefined
  if (input.clientId !== undefined && input.clientId !== null && input.clientId !== '') {
    clientId = Number(input.clientId)
    if (!Number.isInteger(clientId) || clientId < 1) return { ok: false, error: 'clientId must be a positive integer' }
  }
  return { ok: true, value: { name, slug, domain, sitemapUrl, locale, repository, clientId } }
}

export type WriteResult = { ok: true; project: ProjectRow } | { ok: false; status: 400 | 404 | 409; error: string }

const isUniqueViolation = (err: unknown) => (err as { code?: string })?.code === '23505'
const conflictText = (err: unknown) => ((err as { constraint?: string })?.constraint ?? '').includes('slug') ? 'a project with this slug already exists' : 'a project with this domain already exists'

/**
 * Creates an ACTIVE project. The new row is immediately visible to every project-based screen (they all read `listProjects`).
 * `clients.id` is required by the schema: without `clientId` the project gets the client of the same name (found or created) —
 * the convention the existing projects already follow. There are no users/auth/roles here.
 */
export async function createProject(db: Queryable, input: ProjectInput): Promise<WriteResult> {
  const v = validateProjectInput(input)
  if (!v.ok) return { ok: false, status: 400, error: v.error }
  const p = v.value
  try {
    let clientId = p.clientId
    if (clientId === undefined) {
      const found = await db.query('SELECT id FROM clients WHERE name = $1', [p.name])
      clientId = found.rows[0]?.id as number | undefined
      if (clientId === undefined) clientId = (await db.query('INSERT INTO clients (name) VALUES ($1) RETURNING id', [p.name])).rows[0].id as number
    } else if ((await db.query('SELECT 1 FROM clients WHERE id = $1', [clientId])).rows.length === 0) {
      return { ok: false, status: 400, error: 'client not found' }
    }
    const { rows } = await db.query(
      'INSERT INTO projects (client_id, name, slug, domain, sitemap_url, locale, repository) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [clientId, p.name, p.slug, p.domain, p.sitemapUrl, p.locale, p.repository],
    )
    return { ok: true, project: (await getProject(db, rows[0].id as number))! }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, status: 409, error: conflictText(err) }
    throw err
  }
}

export type ProjectPatch = { name?: unknown; domain?: unknown; sitemapUrl?: unknown; locale?: unknown; repository?: unknown; slug?: unknown; archived?: unknown }

/**
 * Edit (name, domain, sitemapUrl, locale, repository) and/or archive / restore (`archived: true | false`). The slug is NOT editable: other
 * systems address the project by it (CRM inbound, observers, Unified). Archiving keeps all data; it only hides the project.
 */
export async function updateProject(db: Queryable, id: number, patch: ProjectPatch): Promise<WriteResult> {
  const current = await getProject(db, id)
  if (!current) return { ok: false, status: 404, error: 'project not found' }
  if (patch.slug !== undefined) return { ok: false, status: 400, error: 'slug cannot be changed' }
  if (patch.archived !== undefined && typeof patch.archived !== 'boolean') return { ok: false, status: 400, error: 'archived must be true or false' }

  const sets: string[] = []
  const params: unknown[] = []
  const set = (column: string, value: unknown) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  const touchesFields = ['name', 'domain', 'sitemapUrl', 'locale', 'repository'].some((k) => (patch as Record<string, unknown>)[k] !== undefined)
  if (touchesFields) {
    const v = validateProjectInput({
      name: patch.name ?? current.name,
      slug: current.slug ?? undefined,
      domain: patch.domain ?? current.domain,
      sitemapUrl: patch.sitemapUrl !== undefined ? patch.sitemapUrl : patch.domain !== undefined ? '' : current.sitemap_url,
      locale: patch.locale !== undefined ? patch.locale : current.locale,
      repository: patch.repository !== undefined ? patch.repository : current.repository,
    })
    if (!v.ok) return { ok: false, status: 400, error: v.error }
    if (patch.name !== undefined) set('name', v.value.name)
    if (patch.domain !== undefined) set('domain', v.value.domain)
    if (patch.sitemapUrl !== undefined || patch.domain !== undefined) set('sitemap_url', v.value.sitemapUrl)
    if (patch.locale !== undefined) set('locale', v.value.locale)
    if (patch.repository !== undefined) set('repository', v.value.repository)
  }
  if (patch.archived !== undefined) sets.push(patch.archived ? 'archived_at = COALESCE(archived_at, now())' : 'archived_at = NULL')
  if (sets.length === 0) return { ok: false, status: 400, error: 'nothing to update' }

  params.push(id)
  try {
    await db.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length}`, params)
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, status: 409, error: conflictText(err) }
    throw err
  }
  return { ok: true, project: (await getProject(db, id))! }
}
