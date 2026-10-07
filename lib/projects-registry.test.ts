import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { CLIENTS_WITH_PROJECT_COUNT_SQL, createProject, getProject, listProjects, normalizeDomain, slugify, updateProject, validateProjectInput } from './projects-registry.ts'

// ---- pure validation ----------------------------------------------------------------------------------------------

test('validation: name + domain required; slug defaults to the name; sitemap defaults to <domain>/sitemap.xml; locale optional', () => {
  const ok = validateProjectInput({ name: ' Drive Set ', domain: 'driveset.ru/' })
  assert.ok(ok.ok)
  assert.deepEqual(ok.ok && ok.value, { name: 'Drive Set', slug: 'drive-set', domain: 'https://driveset.ru', sitemapUrl: 'https://driveset.ru/sitemap.xml', locale: null, clientId: undefined })
  const full = validateProjectInput({ name: 'X', slug: 'x_1', domain: 'https://x.io', sitemapUrl: 'https://x.io/map.xml', locale: 'RU' })
  assert.ok(full.ok && full.value.slug === 'x_1' && full.value.sitemapUrl === 'https://x.io/map.xml' && full.value.locale === 'ru')
  for (const bad of [{}, { name: '', domain: 'a.ru' }, { name: 'A' }, { name: 'A', domain: 'not a domain' }, { name: 'A', domain: 'https://a.ru/path' }, { name: 'A', domain: 'a.ru', slug: 'Bad Slug' }, { name: 'A', domain: 'a.ru', sitemapUrl: 'ftp://a.ru/s' }, { name: 'A', domain: 'a.ru', locale: 'russian' }, { name: 'Привет', domain: 'a.ru' }, { name: 'A', domain: 'a.ru', clientId: 0 }]) {
    assert.equal(validateProjectInput(bad as never).ok, false, JSON.stringify(bad))
  }
  assert.equal(normalizeDomain('https://user:pw@a.ru'), null)
  assert.equal(slugify('OLNOO Insurance!'), 'olnoo-insurance')
})

// ---- registry against Postgres (skipped without migration 0017) -----------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'
let seq = 0

async function withDb(t: TestContext, fn: (pool: Pool, tag: string) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT archived_at, locale, slug FROM projects LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migration 0017 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const tag = `reg${Date.now()}${++seq}`
  try {
    await fn(pool, tag)
  } finally {
    await pool.query(`DELETE FROM clients WHERE name LIKE $1`, [`__${tag}%`]) // cascades to the test projects
    await pool.end()
  }
}

const input = (tag: string, n: string, extra: Record<string, unknown> = {}) => ({ name: `__${tag}-${n}`, slug: `${tag}-${n}`, domain: `https://${tag}-${n}.example.com`, ...extra })

test('create project: active at once, visible in the shared active list, defaults filled, client created by name', async (t) => {
  await withDb(t, async (pool, tag) => {
    const r = await createProject(pool, input(tag, 'a', { locale: 'ru' }))
    assert.ok(r.ok)
    const p = r.ok ? r.project : null
    assert.equal(p!.archived_at, null)
    assert.equal(p!.sitemap_url, `https://${tag}-a.example.com/sitemap.xml`)
    assert.equal(p!.locale, 'ru')
    assert.equal(p!.slug, `${tag}-a`)
    assert.equal(p!.client_name, `__${tag}-a`)
    assert.ok((await listProjects(pool)).some((x) => x.id === p!.id)) // no code change needed for a new project to appear
  })
})

test('create project: duplicate domain / slug → 409, invalid → 400', async (t) => {
  await withDb(t, async (pool, tag) => {
    await createProject(pool, input(tag, 'a'))
    const dupDomain = await createProject(pool, { ...input(tag, 'b'), domain: `https://${tag}-a.example.com` })
    assert.deepEqual([dupDomain.ok, !dupDomain.ok && dupDomain.status], [false, 409])
    const dupSlug = await createProject(pool, { ...input(tag, 'c'), slug: `${tag}-a` })
    assert.deepEqual([dupSlug.ok, !dupSlug.ok && dupSlug.status], [false, 409])
    const bad = await createProject(pool, { name: '', domain: 'x' })
    assert.deepEqual([bad.ok, !bad.ok && bad.status], [false, 400])
  })
})

test('edit project: name / domain / sitemap / locale change; the slug cannot; unknown id → 404', async (t) => {
  await withDb(t, async (pool, tag) => {
    const created = await createProject(pool, input(tag, 'a'))
    const id = created.ok ? created.project.id : 0
    const edited = await updateProject(pool, id, { name: `__${tag}-renamed`, locale: 'en', sitemapUrl: `https://${tag}-a.example.com/map.xml` })
    assert.ok(edited.ok)
    assert.deepEqual(edited.ok && [edited.project.name, edited.project.locale, edited.project.sitemap_url, edited.project.slug], [`__${tag}-renamed`, 'en', `https://${tag}-a.example.com/map.xml`, `${tag}-a`])
    const moved = await updateProject(pool, id, { domain: `https://${tag}-new.example.com` })
    assert.ok(moved.ok && moved.project.domain === `https://${tag}-new.example.com` && moved.project.sitemap_url === `https://${tag}-new.example.com/sitemap.xml`)
    const slug = await updateProject(pool, id, { slug: 'other' })
    assert.deepEqual([slug.ok, !slug.ok && slug.status], [false, 400])
    assert.deepEqual([(await updateProject(pool, id, {})).ok, (await updateProject(pool, 2_000_000_000, { name: 'x' })).ok], [false, false])
    assert.equal((await getProject(pool, id))!.slug, `${tag}-a`)
  })
})

test('archive hides the project from the active list (data stays); restore brings it back; archived only on an explicit request', async (t) => {
  await withDb(t, async (pool, tag) => {
    const created = await createProject(pool, input(tag, 'a'))
    const id = created.ok ? created.project.id : 0
    await pool.query(`INSERT INTO pages (project_id, url) VALUES ($1, $2)`, [id, `https://${tag}-a.example.com/p`])
    const archived = await updateProject(pool, id, { archived: true })
    assert.ok(archived.ok && archived.project.archived_at !== null)
    assert.ok(!(await listProjects(pool)).some((x) => x.id === id)) // default = active only
    assert.ok((await listProjects(pool, { archived: 'include' })).some((x) => x.id === id))
    assert.ok((await listProjects(pool, { archived: 'only' })).some((x) => x.id === id))
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM pages WHERE project_id = $1', [id])).rows[0].n, 1) // nothing deleted
    const again = await updateProject(pool, id, { archived: true }) // idempotent, keeps the first timestamp
    assert.ok(again.ok && archived.ok && String(again.project.archived_at) === String(archived.project.archived_at))
    const restored = await updateProject(pool, id, { archived: false })
    assert.ok(restored.ok && restored.project.archived_at === null)
    assert.ok((await listProjects(pool)).some((x) => x.id === id))
    assert.ok(!(await listProjects(pool, { archived: 'only' })).some((x) => x.id === id))
    assert.equal((await updateProject(pool, id, { archived: 'yes' as never })).ok, false)
  })
})

test('clients project_count counts only ACTIVE projects: archived is excluded, restore brings it back', async (t) => {
  await withDb(t, async (pool, tag) => {
    const a = await createProject(pool, input(tag, 'a'))
    const clientId = a.ok ? a.project.client_id : 0
    const b = await createProject(pool, { ...input(tag, 'b'), clientId })
    const count = async () => (await pool.query(CLIENTS_WITH_PROJECT_COUNT_SQL)).rows.find((r) => r.id === clientId)!.project_count
    assert.equal(await count(), 2) // active projects are counted
    assert.ok(b.ok && (await updateProject(pool, b.project.id, { archived: true })).ok)
    assert.equal(await count(), 1) // the archived one is not
    assert.ok((await updateProject(pool, b.ok ? b.project.id : 0, { archived: false })).ok)
    assert.equal(await count(), 2)
  })
})

// ---- who reads the project list ------------------------------------------------------------------------------------

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('Technical SEO «Check all» takes its projects from the registry (active only), with no hand-written list', () => {
  const route = read('../app/api/seo-health/route.ts')
  assert.match(route, /listProjects\(pool\)/)
  assert.doesNotMatch(route, /FROM projects/)
  assert.match(read('./projects-registry.ts'), /ACTIVE_PROJECT_SQL = 'pr\.archived_at IS NULL'/)
})

test('project-based screens use the shared list and carry no hardcoded project names / allowlists', () => {
  for (const f of ['../components/project-selector.tsx', '../components/sections/overview.tsx', '../components/sections/admin-overview.tsx', '../components/sections/projects-view.tsx', '../components/sections/seo-project-picker.tsx', '../app/api/seo-health/route.ts', '../app/api/projects/route.ts']) {
    const src = read(f)
    assert.doesNotMatch(src, /import \{[^}]*\bprojects\b[^}]*\} from '@\/lib\/data'/, f)
    assert.doesNotMatch(src, /\b(driveset|insurance|aura estate|olnoo\.com)\b/i, f)
  }
  assert.match(read('../components/project-selector.tsx'), /useProjects\(\)/)
  assert.match(read('../components/sections/overview.tsx'), /useProjects\(\)/)
  assert.match(read('../components/sections/admin-overview.tsx'), /useProjects\(\)/)
  assert.match(read('../components/sections/seo-project-picker.tsx'), /fetch\('\/api\/projects'\)/)
  assert.doesNotMatch(read('./data.ts'), /export const projects\b/)
})

test('the clients API counts projects through the shared active-only SQL', () => {
  assert.match(read('../app/api/clients/route.ts'), /CLIENTS_WITH_PROJECT_COUNT_SQL/)
  assert.doesNotMatch(read('../app/api/clients/route.ts'), /JOIN projects/)
  assert.match(read('./projects-registry.ts'), /LEFT JOIN projects p ON p\.client_id = c\.id AND p\.archived_at IS NULL/)
})

test('no hard delete: the projects API has no DELETE and the UI never calls it', () => {
  assert.doesNotMatch(read('../app/api/projects/[id]/route.ts'), /export (async function|const) DELETE/)
  assert.doesNotMatch(read('../components/sections/projects-view.tsx'), /method: 'DELETE'/)
})
