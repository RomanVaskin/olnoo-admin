import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareIssues, issueKey, readLastResult, readLastResults, saveLastResult } from './seo-health-store.ts'
import type { Issue, ProjectHealth } from './seo-health.ts'

const issue = (code: string, url?: string, message = `${code} message`, severity: Issue['severity'] = 'WARNING'): Issue => ({ severity, code, ...(url ? { url } : {}), message })

// ---- C / D: recheck comparison (pure) -----------------------------------------------------------------------------------

test('recheck: resolved / stillFailing / newIssues', () => {
  const r = compareIssues([issue('robots_missing'), issue('title_missing', '/x')], [issue('title_missing', '/x'), issue('h1_missing', '/y')])
  assert.deepEqual(r.resolved.map(issueKey), ['robots_missing|'])
  assert.deepEqual(r.stillFailing.map(issueKey), ['title_missing|/x'])
  assert.deepEqual(r.newIssues.map(issueKey), ['h1_missing|/y'])
})

test('issue identity is code + url: message / severity differences are not new or resolved; same code on another url is', () => {
  const r = compareIssues([issue('title_missing', '/x', 'old text')], [issue('title_missing', '/x', 'completely different text', 'ERROR')])
  assert.deepEqual([r.resolved.length, r.stillFailing.length, r.newIssues.length], [0, 1, 0])
  const moved = compareIssues([issue('title_missing', '/x')], [issue('title_missing', '/z')])
  assert.deepEqual([moved.resolved.length, moved.stillFailing.length, moved.newIssues.length], [1, 0, 1])
  const dup = compareIssues([issue('a', '/p'), issue('a', '/p')], [])
  assert.equal(dup.resolved.length, 1) // duplicates count once
  assert.deepEqual(compareIssues([], []), { resolved: [], stillFailing: [], newIssues: [] })
})

// ---- B: storage (fake db: no Postgres, no network) ----------------------------------------------------------------------

const health = (over: Partial<ProjectHealth> = {}): ProjectHealth => ({
  projectId: 7, projectName: 'DriveSet', domain: 'https://driveset.ru', sitemapUrl: 'https://driveset.ru/sitemap.xml',
  site: { status: 'OK', httpStatus: 200 }, robots: { status: 'Missing', httpStatus: 404, disallowAll: false }, sitemap: { status: 'OK', httpStatus: 200, urlCount: 1 },
  pages: [], pagesTruncated: false, issues: [issue('robots_missing')], errors: 0, warnings: 1, overall: 'Warning', checkedAt: '2026-10-07T10:00:00.000Z', ...over,
})

test('storage: the result is saved as JSON + checkedAt and the saved result reads back without any fetch', async () => {
  const store = new Map<number, { json: string; at: string }>()
  const queries: string[] = []
  const db = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push(text)
      if (text.startsWith('UPDATE projects SET seo_health_last_result')) { store.set(params[2] as number, { json: params[0] as string, at: params[1] as string }); return { rows: [] } }
      if (text.startsWith('SELECT seo_health_last_result')) return { rows: [{ seo_health_last_result: JSON.parse(store.get(params[0] as number)?.json ?? 'null') }] }
      return { rows: [{ id: 7, name: 'DriveSet', domain: 'https://driveset.ru', repository: 'RomanVaskin/driveset', seo_health_last_result: JSON.parse(store.get(7)!.json) }] }
    },
  }
  const down = health({ site: { status: 'Error', httpStatus: null }, sitemap: { status: 'Error', httpStatus: null, urlCount: null }, issues: [issue('site_unavailable', undefined, 'down', 'ERROR')], errors: 1, warnings: 0, overall: 'Error' })
  await saveLastResult(db, down) // site down is a valid result
  assert.equal(store.get(7)!.at, down.checkedAt)
  assert.deepEqual(await readLastResult(db, 7), down)
  assert.equal(await readLastResult(db, 8), null) // never checked
  const all = await readLastResults(db)
  assert.deepEqual(all, [{ ...down, repository: 'RomanVaskin/driveset' }])
  assert.match(queries[queries.length - 1], /archived_at IS NULL/) // archived projects never take part
})

test('a database failure propagates (it is not turned into an SEO issue)', async () => {
  const db = { query: async () => { throw new Error('db down') } }
  await assert.rejects(saveLastResult(db, health()), /db down/)
  await assert.rejects(readLastResults(db), /db down/)
})

test('the synthetic check_failed result is a plain serializable ProjectHealth', () => {
  const synthetic = health({ sitemapUrl: null, issues: [issue('check_failed', undefined, 'The check itself failed', 'ERROR')], errors: 1, warnings: 0, overall: 'Error' })
  assert.deepEqual(JSON.parse(JSON.stringify(synthetic)), synthetic)
})

test('mode=last: active project A with a saved result and B never checked → both returned; B is notChecked with no fake health', async () => {
  const a = health({ projectId: 1, projectName: 'A' })
  const db = {
    query: async (text: string) => {
      assert.match(text, /archived_at IS NULL/)
      assert.doesNotMatch(text, /seo_health_last_result IS NOT NULL/) // not-yet-checked projects must not be filtered out
      return { rows: [
        { id: 1, name: 'A', domain: 'https://a.example', repository: null, seo_health_last_result: a },
        { id: 2, name: 'B', domain: 'https://b.example', repository: 'o/b', seo_health_last_result: null },
      ] }
    },
  }
  const rows = await readLastResults(db)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { ...a, repository: null })
  assert.deepEqual(rows[1], { notChecked: true, projectId: 2, projectName: 'B', domain: 'https://b.example', repository: 'o/b' })
  for (const k of ['overall', 'site', 'robots', 'sitemap', 'issues', 'checkedAt']) assert.ok(!(k in rows[1]), k) // no fake SEO status
})

test('per-project recheck of a never-checked project: the first result replaces its notChecked row (no recheck block: nothing to compare)', async () => {
  const db = { query: async () => ({ rows: [{ seo_health_last_result: null }] }) }
  assert.equal(await readLastResult(db, 2), null) // route: previous = null → no `recheck`, saved result returned as a full ProjectHealth
  // the screen's replace-by-projectId step (components/sections/seo-health.tsx `recheck`):
  const rows: ({ projectId: number } & Record<string, unknown>)[] = [{ projectId: 2, notChecked: true }]
  const fresh = { ...health({ projectId: 2 }), repository: 'o/b' }
  const next = rows.map((x) => (x.projectId === 2 ? fresh : x))
  assert.equal(next[0], fresh)
  assert.equal((next[0] as { notChecked?: boolean }).notChecked, undefined)
})
