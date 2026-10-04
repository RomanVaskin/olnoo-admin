import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Pool } from 'pg'
import { insertLead, type InsertLeadResult, type LeadRow } from './lead-insert.ts'
import { parseLeadAttribution, type LeadAttribution } from './lead-attribution.ts'

// DB integration tests; skipped without a Postgres that has migration 0015 applied.
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const NOW = Date.now()

async function withDb(t: TestContext, fn: (pool: Pool, project: () => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT lead_tracking_id, metrika_client_id, yclid, first_seen_at FROM leads LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migration 0015 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_lead_insert__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
  const project = async () =>
    (await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'p', $2, '') RETURNING id`, [clientId, `__li-${Date.now()}-${Math.random().toString(36).slice(2)}.example`])).rows[0].id as number
  try {
    await fn(pool, project)
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

const attr = (input: Parameters<typeof parseLeadAttribution>[0] = {}): LeadAttribution => {
  const r = parseLeadAttribution(input, NOW)
  assert.ok(!('error' in r))
  return r as LeadAttribution
}

let n = 0
const lead = (projectId: number, attribution: LeadAttribution, extra: Partial<LeadRow> = {}): LeadRow => ({
  id: `li-${Date.now()}-${++n}`, projectId, name: 'Lead', company: '', email: '', service: 's', message: '', source: 'Ads', notes: '', phone: '+70000000000', contact: null,
  landingPage: '', pagePath: '/p', referrer: '', locale: '', utmSource: 'yandex', utmMedium: 'cpc', utmCampaign: '1', utmContent: '2', utmTerm: 'kw',
  attribution, ...extra,
})
const created = (r: InsertLeadResult) => {
  assert.ok(!('error' in r), `unexpected error: ${JSON.stringify(r)}`)
  return r as Extract<InsertLeadResult, { row: unknown }>
}
const count = async (pool: Pool, projectId: number) => Number((await pool.query('SELECT count(*) FROM leads WHERE project_id = $1', [projectId])).rows[0].count)

test('an old lead without any attribution field is still created (all four columns NULL)', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const r = created(await insertLead(pool, lead(p, attr())))
    assert.equal(r.replay, false)
    assert.equal(r.row.lead_tracking_id, null)
    assert.equal(r.row.metrika_client_id, null)
    assert.equal(r.row.yclid, null)
    assert.equal(r.row.first_seen_at, null)
    assert.equal(r.row.status, 'New')
    // two old-style leads never collide on the (partial) unique index
    created(await insertLead(pool, lead(p, attr())))
    assert.equal(await count(pool, p), 2)
  })
})

test('a lead with all four attribution fields is stored; ClientID comes back as the same string', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const clientId = '18446744073709551615'
    const r = created(await insertLead(pool, lead(p, attr({ leadTrackingId: UUID_A, metrikaClientId: clientId, yclid: 'yc-123', firstSeenAt: '2026-10-04T21:00:00+03:00' }))))
    assert.equal(r.replay, false)
    assert.equal(r.row.lead_tracking_id, UUID_A)
    assert.equal(r.row.metrika_client_id, clientId)
    assert.equal(typeof r.row.metrika_client_id, 'string')
    assert.equal(r.row.yclid, 'yc-123')
    assert.equal(new Date(r.row.first_seen_at as string).toISOString(), '2026-10-04T18:00:00.000Z')
    const stored = (await pool.query('SELECT metrika_client_id FROM leads WHERE id = $1', [r.row.id])).rows[0]
    assert.equal(stored.metrika_client_id, clientId)
    // the existing tracking columns are untouched by the new ones
    assert.equal(r.row.utm_campaign, '1')
    assert.equal(r.row.page_path, '/p')
  })
})

test('a duplicate lead_tracking_id creates no second lead and returns the existing one, unchanged', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const first = created(await insertLead(pool, lead(p, attr({ leadTrackingId: UUID_A, metrikaClientId: '111' }), { name: 'First', utmCampaign: 'orig' })))
    const second = created(await insertLead(pool, lead(p, attr({ leadTrackingId: UUID_A, metrikaClientId: '222' }), { name: 'Second', utmCampaign: 'changed' })))
    assert.equal(first.replay, false)
    assert.equal(second.replay, true)
    assert.equal(second.row.id, first.row.id)
    assert.equal(await count(pool, p), 1)
    const stored = (await pool.query('SELECT name, utm_campaign, metrika_client_id FROM leads WHERE id = $1', [first.row.id])).rows[0]
    assert.deepEqual(stored, { name: 'First', utm_campaign: 'orig', metrika_client_id: '111' }) // nothing was overwritten
  })
})

test('concurrent submissions with the same lead_tracking_id produce exactly one lead', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const results = await Promise.all(Array.from({ length: 6 }, () => insertLead(pool, lead(p, attr({ leadTrackingId: UUID_B })))))
    const rows = results.map(created)
    assert.equal(rows.filter((r) => !r.replay).length, 1)
    assert.equal(new Set(rows.map((r) => r.row.id)).size, 1)
    assert.equal(await count(pool, p), 1)
  })
})

test('the same lead_tracking_id in another project is a conflict that leaks no lead data', async (t) => {
  await withDb(t, async (pool, project) => {
    const a = await project()
    const b = await project()
    created(await insertLead(pool, lead(a, attr({ leadTrackingId: UUID_A }), { name: 'Private A' })))
    const r = await insertLead(pool, lead(b, attr({ leadTrackingId: UUID_A })))
    assert.deepEqual(r, { error: 'lead_tracking_id is already used', status: 409 })
    assert.equal(await count(pool, b), 0)
    assert.ok(!JSON.stringify(r).includes('Private A'))
  })
})

test('no identifier value appears in console output on the conflict path', async (t) => {
  await withDb(t, async (pool, project) => {
    const a = await project()
    const b = await project()
    const captured: string[] = []
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error }
    for (const k of Object.keys(originals) as (keyof typeof originals)[]) console[k] = (...args: unknown[]) => void captured.push(args.map(String).join(' '))
    try {
      const withIds = attr({ leadTrackingId: UUID_A, metrikaClientId: '987654321987654321', yclid: 'SECRET-YCLID' })
      created(await insertLead(pool, lead(a, withIds)))
      const conflict = await insertLead(pool, lead(b, withIds))
      assert.ok('error' in conflict)
      assert.ok(!JSON.stringify(conflict).includes('987654321987654321'))
    } finally {
      Object.assign(console, originals)
    }
    assert.equal(captured.filter((l) => l.includes('987654321987654321') || l.includes('SECRET-YCLID') || l.includes(UUID_A)).length, 0)
  })
})
