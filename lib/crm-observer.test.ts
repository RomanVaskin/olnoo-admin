import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { buildPeriod, MAX_PERIOD_DAYS, parseObserverQuery, readLeadsForPeriod, type ObserverError, type ObserverPeriod, type ObserverQuery } from './crm-observer.ts'

const q = (s: string) => new URLSearchParams(s)
const ok = <T>(v: T | ObserverError): T => {
  assert.ok(!('error' in (v as object)), `unexpected error: ${JSON.stringify(v)}`)
  return v as T
}
const bad = (v: unknown, status = 400) => {
  assert.ok(v && typeof v === 'object' && 'error' in v, 'expected an error')
  assert.equal((v as ObserverError).status, status)
}

// ---- period + query validation (pure) ----

test('period: inclusive Moscow calendar days → UTC instants (from inclusive, to+1 day exclusive)', () => {
  const p = ok(buildPeriod('2026-10-01', '2026-10-03')) as ObserverPeriod
  assert.equal(p.timezone, 'Europe/Moscow')
  assert.equal(p.fromUtc, '2026-09-30T21:00:00.000Z') // 2026-10-01 00:00 MSK
  assert.equal(p.toUtcExclusive, '2026-10-03T21:00:00.000Z') // 2026-10-04 00:00 MSK
  const one = ok(buildPeriod('2026-10-03', '2026-10-03')) as ObserverPeriod
  assert.equal(one.fromUtc, '2026-10-02T21:00:00.000Z')
  assert.equal(one.toUtcExclusive, '2026-10-03T21:00:00.000Z')
})

test('from/to validation', () => {
  bad(buildPeriod(null, '2026-10-03'))
  bad(buildPeriod('2026-10-01', null))
  bad(buildPeriod('', ''))
  for (const v of ['2026-1-1', '2026/10/01', '01-10-2026', '2026-10-01T00:00:00Z', ' 2026-10-01', '2026-13-01', '2026-02-30', '2026-00-10', 'tomorrow']) {
    bad(buildPeriod(v, '2026-10-03'), 400)
    bad(buildPeriod('2026-10-01', v), 400)
  }
  bad(buildPeriod('2026-10-04', '2026-10-03')) // from after to
  ok(buildPeriod('2026-10-01', '2026-10-01'))
  // length cap: exactly MAX_PERIOD_DAYS is fine, one more is not
  const end = Date.parse('2026-10-03T00:00:00Z')
  const day = (offset: number) => new Date(end - offset * 86_400_000).toISOString().slice(0, 10)
  ok(buildPeriod(day(MAX_PERIOD_DAYS - 1), '2026-10-03'))
  bad(buildPeriod(day(MAX_PERIOD_DAYS), '2026-10-03'))
})

test('query: exactly one project slug, never "all", extra params are ignored', () => {
  const good = ok(parseObserverQuery(q('project=driveset&from=2026-10-01&to=2026-10-03'))) as ObserverQuery
  assert.equal(good.project, 'driveset')
  bad(parseObserverQuery(q('from=2026-10-01&to=2026-10-03')))
  bad(parseObserverQuery(q('project=all&from=2026-10-01&to=2026-10-03')))
  bad(parseObserverQuery(q('project=ALL&from=2026-10-01&to=2026-10-03')))
  bad(parseObserverQuery(q('project=&from=2026-10-01&to=2026-10-03')))
  bad(parseObserverQuery(q('project=driveset&project=olnoo&from=2026-10-01&to=2026-10-03'))) // no second filter
  bad(parseObserverQuery(q('project=drive set&from=2026-10-01&to=2026-10-03')))
  bad(parseObserverQuery(q("project=x';DROP TABLE leads;--&from=2026-10-01&to=2026-10-03")))
  const extra = ok(parseObserverQuery(q('project=driveset&from=2026-10-01&to=2026-10-03&project_id=999&status=Won&limit=1000000'))) as ObserverQuery
  assert.equal(extra.project, 'driveset')
  bad(parseObserverQuery(q('project=driveset&from=2026-10-04&to=2026-10-03')))
})

test('no mutations: the route exports GET only and the data layer issues SELECT statements only', async () => {
  const route = readFileSync(new URL('../app/api/crm/observer/leads/route.ts', import.meta.url), 'utf8')
  const exportedFunctions = [...route.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1])
  assert.deepEqual(exportedFunctions, ['GET'])
  const lib = readFileSync(new URL('./crm-observer.ts', import.meta.url), 'utf8')
  assert.ok(!/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/.test(lib.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'no write SQL keywords in code')

  const statements: string[] = []
  const spy = {
    query: async (sql: string) => {
      statements.push(sql)
      return sql.includes('FROM projects') ? { rows: [{ id: 1, slug: 'p', name: 'P' }] } : { rows: [] }
    },
  }
  await readLeadsForPeriod(spy as never, ok(parseObserverQuery(q('project=p&from=2026-10-01&to=2026-10-02'))) as ObserverQuery)
  assert.equal(statements.length, 2)
  for (const s of statements) assert.match(s.trim(), /^SELECT\b/)
})

// ---- DB integration (skipped without a reachable Postgres that has the leads table, migrations through 0015) ----

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: TestContext, fn: (pool: Pool, project: (name?: string) => Promise<{ id: number; slug: string }>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT page_path, utm_content, utm_term, phone, contact, lead_tracking_id, metrika_client_id, yclid, first_seen_at FROM leads LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with the leads table incl. migration 0015 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_crm_observer__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
  const project = async (name = 'p') => {
    const slug = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const row = (await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, $2, $3, '', $4) RETURNING id`, [clientId, name, `${slug}.example`, slug])).rows[0]
    return { id: row.id as number, slug }
  }
  try {
    await fn(pool, project)
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId]) // cascades to projects and leads
    await pool.end()
  }
}

let seq = 0
async function lead(pool: Pool, projectId: number, createdAt: string, extra: Record<string, string | null> = {}) {
  const id = `crm-obs-${Date.now()}-${++seq}`
  await pool.query(
    `INSERT INTO leads (id, project_id, name, email, phone, contact, source, status, service, landing_page, page_path, referrer,
                        utm_source, utm_medium, utm_campaign, utm_content, utm_term, created_at,
                        lead_tracking_id, metrika_client_id, yclid, first_seen_at)
     VALUES ($1, $2, $3, '', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21::timestamptz)`,
    [
      id, projectId, extra.name ?? 'Lead', 'phone' in extra ? extra.phone : '+70000000000', extra.contact ?? null, extra.source ?? 'Ads', extra.status ?? 'New', extra.service ?? '',
      extra.landing_page ?? '', extra.page_path ?? '', extra.referrer ?? '', extra.utm_source ?? '', extra.utm_medium ?? '', extra.utm_campaign ?? '',
      extra.utm_content ?? '', extra.utm_term ?? '', createdAt,
      extra.lead_tracking_id ?? null, extra.metrika_client_id ?? null, extra.yclid ?? null, extra.first_seen_at ?? null,
    ],
  )
  return id
}

const query = (slug: string, from: string, to: string) => ok(parseObserverQuery(q(`project=${slug}&from=${from}&to=${to}`))) as ObserverQuery
const read = async (pool: Pool, slug: string, from: string, to: string, limit?: number) => {
  const out = await readLeadsForPeriod(pool, query(slug, from, to), limit)
  return ok(out)
}

test('DB: period filtering uses Moscow calendar days — boundaries, ordering', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const before = await lead(pool, p.id, '2026-09-30T20:59:59Z') // 23:59:59 MSK on 09-30 → outside
    const first = await lead(pool, p.id, '2026-09-30T21:00:00Z') // 00:00:00 MSK on 10-01 → inside (inclusive)
    const mid = await lead(pool, p.id, '2026-10-02T09:00:00Z')
    const last = await lead(pool, p.id, '2026-10-03T20:59:59Z') // 23:59:59 MSK on 10-03 → inside
    const after = await lead(pool, p.id, '2026-10-03T21:00:00Z') // 00:00:00 MSK on 10-04 → outside (exclusive)
    void before; void after

    const r = await read(pool, p.slug, '2026-10-01', '2026-10-03')
    assert.deepEqual(r.leads.map((l) => l.id), [first, mid, last]) // chronological
    assert.equal(r.totals.leads, 3)
    assert.equal(r.truncated, false)
    assert.equal(r.period.timezone, 'Europe/Moscow')
    assert.equal(r.leads[0].createdAt, '2026-09-30T21:00:00.000Z')

    const single = await read(pool, p.slug, '2026-10-04', '2026-10-04')
    assert.equal(single.totals.leads, 1)
  })
})

test('DB: project isolation — another project never leaks, unknown project is 404', async (t) => {
  await withDb(t, async (pool, project) => {
    const a = await project('A')
    const b = await project('B')
    const la = await lead(pool, a.id, '2026-10-02T09:00:00Z', { name: 'A lead' })
    const lb = await lead(pool, b.id, '2026-10-02T09:00:00Z', { name: 'B lead' })

    const ra = await read(pool, a.slug, '2026-10-01', '2026-10-03')
    assert.deepEqual(ra.leads.map((l) => l.id), [la])
    assert.deepEqual(ra.project, { id: a.id, slug: a.slug, name: 'A' })
    const rb = await read(pool, b.slug, '2026-10-01', '2026-10-03')
    assert.deepEqual(rb.leads.map((l) => l.id), [lb])

    // there is no parameter that can widen the filter: extra params are ignored by the parser
    const tampered = ok(parseObserverQuery(q(`project=${a.slug}&project_id=${b.id}&from=2026-10-01&to=2026-10-03`))) as ObserverQuery
    const rt = ok(await readLeadsForPeriod(pool, tampered))
    assert.deepEqual(rt.leads.map((l) => l.id), [la])

    bad(await readLeadsForPeriod(pool, query('doesnotexist', '2026-10-01', '2026-10-03')), 404)
  })
})

test('DB: every saved UTM field, page, referrer, contact and phone come back (utm_term included)', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    await lead(pool, p.id, '2026-10-02T09:00:00Z', {
      name: 'Anna', phone: '+79990001122', source: 'Ads', status: 'In progress', service: 'Полировка',
      landing_page: 'https://driveset.ru/polirovka-avto?utm_source=yandex', page_path: '/polirovka-avto', referrer: 'https://yandex.ru/',
      utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: '714796268', utm_content: 'ad-1', utm_term: 'полировка фар',
    })
    await lead(pool, p.id, '2026-10-02T10:00:00Z', { name: 'Tg', phone: null, contact: 'tg:123', source: 'Direct' })

    const r = await read(pool, p.slug, '2026-10-01', '2026-10-03')
    assert.deepEqual(
      { ...r.leads[0], id: 'x' },
      {
        id: 'x', createdAt: '2026-10-02T09:00:00.000Z', name: 'Anna', phone: '+79990001122', status: 'In progress', source: 'Ads', service: 'Полировка', contact: null,
        landingPage: 'https://driveset.ru/polirovka-avto?utm_source=yandex', pagePath: '/polirovka-avto', referrer: 'https://yandex.ru/',
        utmSource: 'yandex', utmMedium: 'cpc', utmCampaign: '714796268', utmContent: 'ad-1', utmTerm: 'полировка фар',
        leadTrackingId: null, metrikaClientId: null, yclid: null, firstSeenAt: null, // a lead created before attribution capture
      },
    )
    assert.equal(r.leads[1].phone, null)
    assert.equal(r.leads[1].contact, 'tg:123')
    assert.equal(r.leads[1].utmTerm, '') // stored as "" = not provided
  })
})

test('DB: empty period → 0 leads, not truncated; truncation reports the real total', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const empty = await read(pool, p.slug, '2026-10-01', '2026-10-03')
    assert.deepEqual({ leads: empty.leads, total: empty.totals.leads, truncated: empty.truncated }, { leads: [], total: 0, truncated: false })

    for (let i = 0; i < 3; i++) await lead(pool, p.id, `2026-10-02T0${i}:00:00Z`)
    const capped = await read(pool, p.slug, '2026-10-01', '2026-10-03', 2)
    assert.equal(capped.leads.length, 2)
    assert.equal(capped.totals.leads, 3)
    assert.equal(capped.truncated, true)
  })
})

test('DB: reading changes nothing', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    await lead(pool, p.id, '2026-10-02T09:00:00Z')
    const counts = async () => (await pool.query(`SELECT (SELECT count(*) FROM leads) AS leads, (SELECT count(*) FROM projects) AS projects, (SELECT max(updated_at) FROM leads) AS touched`)).rows[0]
    const before = await counts()
    await read(pool, p.slug, '2026-10-01', '2026-10-03')
    await read(pool, p.slug, '2026-10-01', '2026-10-03')
    assert.deepEqual(await counts(), before)
  })
})

test('DB: attribution identifiers are returned (ClientID as a string); old leads have nulls', async (t) => {
  await withDb(t, async (pool, project) => {
    const p = await project()
    const clientId = '18446744073709551615'
    await lead(pool, p.id, '2026-10-02T09:00:00Z', {
      name: 'New', lead_tracking_id: '0b6f4c1e-5d4a-4f0e-9a3b-7c2d1e8f9a10', metrika_client_id: clientId, yclid: 'yc-1', first_seen_at: '2026-10-01T18:30:00+03:00',
    })
    await lead(pool, p.id, '2026-10-02T10:00:00Z', { name: 'Old' })

    const r = await read(pool, p.slug, '2026-10-01', '2026-10-03')
    const [withIds, old] = r.leads
    assert.equal(withIds.leadTrackingId, '0b6f4c1e-5d4a-4f0e-9a3b-7c2d1e8f9a10')
    assert.equal(withIds.metrikaClientId, clientId)
    assert.equal(typeof withIds.metrikaClientId, 'string')
    assert.equal(withIds.yclid, 'yc-1')
    assert.equal(withIds.firstSeenAt, '2026-10-01T15:30:00.000Z')
    assert.deepEqual([old.leadTrackingId, old.metrikaClientId, old.yclid, old.firstSeenAt], [null, null, null, null])
    // the JSON a consumer receives keeps the ClientID exact (a number would round it)
    assert.ok(JSON.stringify(r).includes(`"metrikaClientId":"${clientId}"`))
  })
})

test('DB: attribution fields do not widen project isolation or the period filter', async (t) => {
  await withDb(t, async (pool, project) => {
    const a = await project('A')
    const b = await project('B')
    const sameId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const la = await lead(pool, a.id, '2026-10-02T09:00:00Z', { lead_tracking_id: sameId, metrika_client_id: '555' })
    await lead(pool, b.id, '2026-10-02T09:00:00Z', { metrika_client_id: '555' }) // same ClientID in another project
    await lead(pool, a.id, '2026-09-30T20:59:59Z', { metrika_client_id: '555' }) // 23:59:59 MSK the day before → outside

    const r = await read(pool, a.slug, '2026-10-01', '2026-10-03')
    assert.deepEqual(r.leads.map((l) => l.id), [la])
    assert.equal(r.totals.leads, 1)
  })
})
