import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { buildPeriod, readLeadSignalsForPeriod, type ObserverPeriod } from './crm-observer.ts'
import { insertLead, leadsHaveTrafficClass, resetTrafficClassProbe, type LeadRow } from './lead-insert.ts'
import { parseLeadAttribution, type LeadAttribution } from './lead-attribution.ts'
import { setTrafficClassOverride } from './traffic-class-store.ts'
import {
  classifyLead,
  effectiveTrafficClass,
  LEGACY_TEST_MARKERS,
  matchesTestUtm,
  normalizeContact,
  parseActivationBoundary,
  parseKnownContacts,
  parseTrafficClass,
  parseTrafficOverride,
  TEST_UTM_PAIRS,
} from './traffic-class.ts'
import { TEST_TRAFFIC_RULES } from './unified-analytics.ts'

// ---- classifier (pure) -----------------------------------------------------------------------------

test('classifier: the historical explicit markers give TEST / legacy_utm_marker (utm_content or utm_term, exact normalised)', () => {
  assert.deepEqual(classifyLead({ project: 'driveset', utmContent: 'a2_production_test' }), { auto: 'TEST', reason: 'legacy_utm_marker' })
  assert.deepEqual(classifyLead({ project: 'driveset', utmTerm: 'test_attribution' }), { auto: 'TEST', reason: 'legacy_utm_marker' })
  assert.deepEqual(classifyLead({ project: 'driveset', utmContent: '  A2_Production_Test ', utmTerm: '' }), { auto: 'TEST', reason: 'legacy_utm_marker' })
})

test('classifier: arbitrary "test" strings, normal leads and other projects are UNKNOWN / unclassified — never REAL', () => {
  const unknown = { auto: 'UNKNOWN', reason: 'unclassified' }
  for (const [content, term] of [['test', 'test'], ['my_test', 'тест'], ['a2_production_test_old', ''], ['1922380925577514960', '---autotargeting'], ['', ''], [undefined, undefined]]) {
    assert.deepEqual(classifyLead({ project: 'driveset', utmContent: content, utmTerm: term }), unknown, `${content}|${term}`)
  }
  assert.deepEqual(classifyLead({ project: 'olnoo', utmContent: 'a2_production_test' }), unknown) // markers are project-specific
  for (const project of ['', '__proto__', 'constructor', 'toString']) assert.deepEqual(classifyLead({ project, utmContent: 'a2_production_test' }), unknown)
  assert.ok(!['REAL'].includes(classifyLead({ project: 'driveset' }).auto))
})

test('effective class = override ?? auto (REAL / TEST / null)', () => {
  assert.equal(effectiveTrafficClass('REAL', 'TEST'), 'TEST') // override TEST over auto REAL
  assert.equal(effectiveTrafficClass('TEST', 'REAL'), 'REAL') // override REAL over auto TEST
  assert.equal(effectiveTrafficClass('TEST', null), 'TEST') // no override → auto
  assert.equal(effectiveTrafficClass('UNKNOWN', null), 'UNKNOWN')
  assert.equal(effectiveTrafficClass('UNKNOWN', 'REAL'), 'REAL')
  assert.equal(effectiveTrafficClass('UNKNOWN', undefined), 'UNKNOWN')
  assert.equal(effectiveTrafficClass('garbage', 'garbage'), 'UNKNOWN') // anything unexpected falls to the safe class
  assert.equal(parseTrafficClass(null), 'UNKNOWN')
  assert.equal(parseTrafficOverride('UNKNOWN'), null) // UNKNOWN is not a valid manual decision
  assert.equal(parseTrafficOverride('TEST'), 'TEST')
})

test('the CRM classifier and Unified share ONE definition of the test markers (test UTM pair + legacy markers)', () => {
  assert.deepEqual(LEGACY_TEST_MARKERS.driveset, { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'] })
  assert.deepEqual(TEST_UTM_PAIRS, [{ source: 'olnoo', medium: 'test' }])
  assert.deepEqual(TEST_TRAFFIC_RULES.driveset, { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'], utmPairs: TEST_UTM_PAIRS })
})

// ---- Test Traffic v1 classifier ---------------------------------------------------------------------

const SINCE = '2026-10-06T09:00:00+03:00' // 06:00Z
const BEFORE = Date.parse('2026-10-06T05:59:59Z')
const AFTER = Date.parse('2026-10-06T06:00:00Z')
const ENV = { DRIVESET_TEST_CLASSIFICATION_SINCE: SINCE, OLNOO_TEST_CONTACTS_DRIVESET: '+7 (999) 123-45-67, tg:123456789; 89990001122' }
const web = (over: Partial<Parameters<typeof classifyLead>[0]> = {}) => classifyLead({ project: 'driveset', intake: 'inbound_api', now: AFTER, env: ENV, utmSource: 'yandex', utmMedium: 'cpc', phone: '+79998887766', ...over })

test('TEST: the new test UTM (utm_source=olnoo AND utm_medium=test), whatever content/term say; exact and normalised', () => {
  assert.deepEqual(web({ utmSource: 'olnoo', utmMedium: 'test', utmContent: 'olnoo_test', utmTerm: 'AbC123' }), { auto: 'TEST', reason: 'test_utm' })
  assert.deepEqual(web({ utmSource: ' OLNOO ', utmMedium: 'Test' }), { auto: 'TEST', reason: 'test_utm' })
  assert.deepEqual(web({ utmSource: 'olnoo', utmMedium: 'test', intake: undefined, now: BEFORE }), { auto: 'TEST', reason: 'test_utm' }) // any intake, any time
  assert.equal(matchesTestUtm('olnoo', 'test'), true)
})

test('no false positives: one half of the pair, similar strings and the marker words in other fields are not TEST', () => {
  for (const [source, medium] of [['olnoo', 'cpc'], ['yandex', 'test'], ['olnoo', ''], ['', 'test'], ['olnoo-x', 'test'], ['olnoo', 'testing'], ['my olnoo', 'test']]) {
    assert.notEqual(web({ utmSource: source, utmMedium: medium }).auto, 'TEST', `${source}|${medium}`)
  }
  assert.notEqual(web({ utmContent: 'olnoo_test' }).auto, 'TEST') // content alone is not the marker
  assert.notEqual(web({ utmTerm: 'olnoo_test_abc', utmCampaign: 'olnoo_test' } as never).auto, 'TEST')
  assert.equal(web({ contact: 'olnoo_test' }).auto, 'REAL') // a stray string in an unrelated field changes nothing
})

test('TEST: historical markers and known test contacts (phone in any formatting, tg:<id>)', () => {
  assert.deepEqual(web({ utmContent: 'a2_production_test' }), { auto: 'TEST', reason: 'legacy_utm_marker' })
  assert.deepEqual(web({ utmTerm: 'test_attribution' }), { auto: 'TEST', reason: 'legacy_utm_marker' })
  for (const phone of ['+79991234567', '8 999 123 45 67', '9991234567', '+7(999)123-45-67']) {
    assert.deepEqual(web({ phone }), { auto: 'TEST', reason: 'known_test_contact' }, phone)
  }
  assert.deepEqual(web({ phone: '+79990001122' }), { auto: 'TEST', reason: 'known_test_contact' }) // the 8… form in the list
  assert.deepEqual(web({ phone: null, contact: 'tg:123456789' }), { auto: 'TEST', reason: 'known_test_contact' })
  assert.deepEqual(web({ phone: '+79991234568' }), { auto: 'REAL', reason: 'web_after_activation' }) // one digit off
  assert.deepEqual(web({ phone: null, contact: 'tg:1234567890' }), { auto: 'REAL', reason: 'web_after_activation' })
})

test('REAL: only the trusted inbound intake at/after the activation boundary and without any test marker', () => {
  assert.deepEqual(web(), { auto: 'REAL', reason: 'web_after_activation' })
  assert.deepEqual(web({ now: AFTER }), { auto: 'REAL', reason: 'web_after_activation' }) // boundary instant included
  assert.deepEqual(web({ now: BEFORE }), { auto: 'UNKNOWN', reason: 'unclassified' }) // before the boundary
  assert.deepEqual(web({ intake: undefined }), { auto: 'UNKNOWN', reason: 'unclassified' }) // Admin UI / Telegram / anything but the inbound API
  assert.deepEqual(classifyLead({ project: 'driveset', now: AFTER, env: ENV, contact: 'tg:777777777' }), { auto: 'UNKNOWN', reason: 'unclassified' }) // off-site lead
  assert.deepEqual(web({ project: 'olnoo' }), { auto: 'UNKNOWN', reason: 'unclassified' }) // not a configured project
  assert.deepEqual(web({ utmSource: 'olnoo', utmMedium: 'test' }).auto, 'TEST') // a marker beats the boundary
})

test('activation boundary: missing or malformed env keeps everything UNKNOWN (fail-safe); the format needs a time zone', () => {
  for (const since of [undefined, '', 'tomorrow', '2026-10-06', '2026-10-06T09:00:00', '2026-13-45T09:00:00+03:00x']) {
    assert.equal(web({ env: { DRIVESET_TEST_CLASSIFICATION_SINCE: since } }).auto, 'UNKNOWN', String(since))
  }
  assert.equal(parseActivationBoundary('2026-10-06T09:00:00+03:00'), Date.parse('2026-10-06T06:00:00Z'))
  assert.equal(parseActivationBoundary('2026-10-06T06:00:00Z'), Date.parse('2026-10-06T06:00:00Z'))
  assert.equal(parseActivationBoundary(null), null)
})

test('known contacts format: separators, normalisation, junk ignored, never partial matches', () => {
  assert.deepEqual([...parseKnownContacts('+7 999 123-45-67,8(999)000-11-22\n tg:42424 ; junk, @name, 123')].sort(), ['phone:79990001122', 'phone:79991234567', 'tg:42424'])
  assert.deepEqual([...parseKnownContacts(undefined)], [])
  assert.equal(normalizeContact('TG:123456'), 'tg:123456')
  assert.equal(normalizeContact('tg:12'), null)
  assert.equal(normalizeContact('@username'), null)
  assert.equal(normalizeContact('+1 202 555 0100'), 'phone:12025550100') // non-RU numbers keep their digits
  assert.equal(normalizeContact(''), null)
  assert.equal(classifyLead({ project: 'driveset', phone: '+79991234567', env: {} }).auto, 'UNKNOWN') // no list configured → no known contact
})

test('plumbing: only the authenticated inbound route sets intake; the Admin UI and Telegram never can produce REAL', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
  assert.match(read('../app/api/leads/inbound/route.ts'), /intake: 'inbound_api'/)
  assert.doesNotMatch(read('../app/api/leads/route.ts'), /\bintake: '/)
  assert.doesNotMatch(read('./telegram-business.ts'), /\bintake: '/)
  const crm = read('./crm.ts')
  assert.match(crm, /intake: input\.intake/)
  assert.match(crm, /phone: phone \|\| null/)
  assert.match(crm, /contact: contact \|\| null/)
})

test('override API: PATCH accepts REAL | TEST | null for trafficClassOverride and rejects anything else', () => {
  const route = readFileSync(new URL('../app/api/leads/[id]/route.ts', import.meta.url), 'utf8')
  assert.match(route, /'trafficClassOverride' in body/)
  assert.match(route, /override !== null && override !== 'REAL' && override !== 'TEST'/)
  assert.match(route, /set\('traffic_class_override', override\)/)
  assert.match(route, /set\('traffic_class_override_at', override === null \? null : new Date\(\)\.toISOString\(\)\)/)
})

// ---- migration text + insert before/after the migration (no database needed) -----------------------------

test('migration 0016: additive columns with safe defaults, CHECK constraints, backfill of the legacy markers only', () => {
  const sql = readFileSync(new URL('../db/migrations/0016_leads_traffic_class.sql', import.meta.url), 'utf8')
  assert.match(sql, /ADD COLUMN IF NOT EXISTS traffic_class_auto TEXT NOT NULL DEFAULT 'UNKNOWN'/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS traffic_class_reason TEXT NOT NULL DEFAULT 'unclassified'/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS traffic_class_override TEXT;/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS traffic_class_override_at TIMESTAMPTZ;/)
  assert.match(sql, /CHECK \(traffic_class_auto IN \('REAL', 'TEST', 'UNKNOWN'\)\)/)
  assert.match(sql, /CHECK \(traffic_class_override IS NULL OR traffic_class_override IN \('REAL', 'TEST'\)\)/)
  assert.match(sql, /slug = 'driveset'/)
  assert.doesNotMatch(sql, /'REAL'\s*,\s*traffic_class_reason|traffic_class_auto = 'REAL'/) // nothing is promoted to REAL
  assert.doesNotMatch(sql, /DROP|DELETE|TRUNCATE/i)
})

function fakeDb(columnsExist: boolean | 'error') {
  const statements: { sql: string; params: unknown[] }[] = []
  return {
    statements,
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params })
      if (sql.includes('information_schema.columns')) {
        if (columnsExist === 'error') throw new Error('catalog unavailable')
        return { rows: columnsExist ? [{ '?column?': 1 }] : [] } as never
      }
      return { rows: [{ id: 'x' }] } as never
    },
  }
}
const baseLead = (over: Partial<LeadRow> = {}): LeadRow => ({
  id: 'x', projectId: 1, name: 'n', company: '', email: '', service: '', message: '', source: 'Ads', notes: '', phone: '+7', contact: null,
  landingPage: '', pagePath: '', referrer: '', locale: '', utmSource: '', utmMedium: '', utmCampaign: '', utmContent: '', utmTerm: '',
  attribution: parseLeadAttribution({}) as LeadAttribution, ...over,
})

test('intake before the migration: the INSERT does not name the new columns, so delivery is unaffected; a missing-catalog answer behaves the same', async () => {
  for (const state of [false, 'error'] as const) {
    resetTrafficClassProbe()
    const db = fakeDb(state)
    await insertLead(db as never, baseLead({ trafficClass: { auto: 'TEST', reason: 'legacy_utm_marker' } }))
    const insert = db.statements.find((s) => s.sql.includes('INSERT INTO leads'))!
    assert.doesNotMatch(insert.sql, /traffic_class/)
    assert.equal(insert.params.length, 24)
  }
})

test('intake after the migration: the classification is written; the probe is cached once positive and re-checked after a negative', async () => {
  resetTrafficClassProbe()
  const db = fakeDb(true)
  await insertLead(db as never, baseLead({ trafficClass: { auto: 'TEST', reason: 'legacy_utm_marker' } }))
  await insertLead(db as never, baseLead({ trafficClass: { auto: 'UNKNOWN', reason: 'unclassified' } }))
  const inserts = db.statements.filter((s) => s.sql.includes('INSERT INTO leads'))
  assert.match(inserts[0].sql, /traffic_class_auto, traffic_class_reason\s*\) VALUES/)
  assert.deepEqual(inserts[0].params.slice(24), ['TEST', 'legacy_utm_marker'])
  assert.deepEqual(inserts[1].params.slice(24), ['UNKNOWN', 'unclassified'])
  assert.equal(db.statements.filter((s) => s.sql.includes('information_schema')).length, 1) // positive answer cached

  resetTrafficClassProbe()
  const late = fakeDb(false)
  assert.equal(await leadsHaveTrafficClass(late as never, 1_000), false)
  assert.equal(await leadsHaveTrafficClass(late as never, 2_000), false)
  assert.equal(late.statements.length, 1) // negative answer not re-queried within 30 s
  assert.equal(await leadsHaveTrafficClass(fakeDb(true) as never, 40_000), true) // re-checked later, migration picked up without restart
  resetTrafficClassProbe()
})

test('intake without a classification (a caller that does not pass one) never names the columns', async () => {
  resetTrafficClassProbe()
  const db = fakeDb(true)
  await insertLead(db as never, baseLead())
  assert.doesNotMatch(db.statements.find((s) => s.sql.includes('INSERT INTO leads'))!.sql, /traffic_class/)
})

// ---- analytics-safe reader (no database needed) ---------------------------------------------------------

function readerDb(rows: Record<string, unknown>[]) {
  const statements: string[] = []
  return {
    statements,
    query: async (sql: string) => {
      statements.push(sql)
      return { rows: sql.includes('FROM projects') ? [{ id: 7, slug: 'driveset', name: 'DriveSet' }] : rows } as never
    },
  }
}
const period = buildPeriod('2026-10-01', '2026-10-03') as ObserverPeriod
const dirtyRow = {
  created_at: '2026-10-02T09:00:00Z', status: 'New', utm_source: 'yandex', utm_medium: 'cpc', utm_campaign: '1', utm_content: 'c', utm_term: 't',
  has_metrika_client_id: true, has_yclid: false, total: '1',
  traffic_class_auto: 'UNKNOWN', traffic_class_reason: 'unclassified', traffic_class_override: 'TEST',
  name: 'LEAK-NAME', phone: 'LEAK-PHONE', contact: 'LEAK-CONTACT', email: 'LEAK-EMAIL', message: 'LEAK-MESSAGE', metrika_client_id: 'LEAK-CLIENT', yclid: 'LEAK-YCLID', lead_tracking_id: 'LEAK-TRACKING',
}

test('reader: the default statement is unchanged (no traffic-class columns → works before the migration); the class fields are opt-in', async () => {
  const plain = readerDb([dirtyRow])
  const result = await readLeadSignalsForPeriod(plain as never, { project: 'driveset', period })
  assert.ok(!('error' in result))
  assert.ok(!plain.statements.find((s) => s.includes('FROM leads'))!.includes('traffic_class'))
  for (const key of ['trafficClass', 'trafficClassAuto', 'trafficClassReason', 'trafficClassOverride']) assert.ok(!(key in result.signals[0]))
})

test('reader with classes: effective class is override ?? auto; no personal data is selected or returned', async () => {
  const db = readerDb([dirtyRow, { ...dirtyRow, traffic_class_auto: 'TEST', traffic_class_reason: 'legacy_utm_marker', traffic_class_override: null }, { ...dirtyRow, traffic_class_auto: 'TEST', traffic_class_override: 'REAL' }])
  const result = await readLeadSignalsForPeriod(db as never, { project: 'driveset', period }, 2000, { withTrafficClass: true })
  assert.ok(!('error' in result))
  assert.deepEqual(result.signals.map((s) => [s.trafficClassAuto, s.trafficClassOverride, s.trafficClass]), [
    ['UNKNOWN', 'TEST', 'TEST'], // override TEST over auto UNKNOWN
    ['TEST', null, 'TEST'], // no override → auto
    ['TEST', 'REAL', 'REAL'], // override REAL over auto TEST
  ])
  assert.equal(result.signals[1].trafficClassReason, 'legacy_utm_marker')
  assert.doesNotMatch(JSON.stringify(result), /LEAK/)
  const sql = db.statements.find((s) => s.includes('FROM leads'))!
  const selected = sql.slice(0, sql.indexOf('FROM leads'))
  for (const column of ['name', 'phone', 'contact', 'email', 'message', 'notes', 'lead_tracking_id']) assert.doesNotMatch(selected, new RegExp(`l\\.${column}\\b`))
  assert.match(selected, /l\.traffic_class_auto, l\.traffic_class_reason, l\.traffic_class_override/)
})

test('override primitive: sets REAL/TEST with a timestamp, clears with null, rejects anything else', async () => {
  const calls: unknown[][] = []
  const db = { query: async (_sql: string, params: unknown[]) => (calls.push(params), { rowCount: 1 } as never) }
  assert.equal(await setTrafficClassOverride(db as never, 'lead-1', 'TEST'), true)
  assert.equal(await setTrafficClassOverride(db as never, 'lead-1', null), true)
  assert.deepEqual(calls, [['lead-1', 'TEST'], ['lead-1', null]])
  await assert.rejects(() => setTrafficClassOverride(db as never, 'lead-1', 'UNKNOWN' as never), /REAL, TEST or null/)
  assert.equal(await setTrafficClassOverride({ query: async () => ({ rowCount: 0 }) as never } as never, 'nope', 'REAL'), false)
})

// ---- real database (skipped without Postgres that has migrations 0015 and 0016) ---------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://olnoo_admin:CHANGE_ME@localhost:5432/olnoo_admin'

async function withDb(t: TestContext, fn: (pool: Pool, projectId: () => Promise<number>) => Promise<void>) {
  const pool = new Pool({ connectionString: DATABASE_URL })
  try {
    await pool.query('SELECT lead_tracking_id, traffic_class_auto, traffic_class_reason, traffic_class_override, traffic_class_override_at FROM leads LIMIT 1')
  } catch (err) {
    t.skip(`No reachable Postgres with migrations 0015+0016 at DATABASE_URL — skipping (${(err as Error).message})`)
    await pool.end()
    return
  }
  const clientId = (await pool.query(`INSERT INTO clients (name) VALUES ('__test_traffic_class__' || clock_timestamp()::text) RETURNING id`)).rows[0].id as number
  const projectId = async () =>
    (await pool.query(`INSERT INTO projects (client_id, name, domain, sitemap_url) VALUES ($1, 'p', $2, '') RETURNING id`, [clientId, `__tc-${Date.now()}-${Math.random().toString(36).slice(2)}.example`])).rows[0].id as number
  try {
    await fn(pool, projectId)
  } finally {
    await pool.query('DELETE FROM clients WHERE id = $1', [clientId])
    await pool.end()
  }
}

let n = 0
const insertRow = async (pool: Pool, projectId: number, utmContent = '', utmTerm = '') => {
  const id = `tc-${Date.now()}-${n++}`
  await pool.query(`INSERT INTO leads (id, project_id, name, email, utm_content, utm_term) VALUES ($1, $2, 'n', '', $3, $4)`, [id, projectId, utmContent, utmTerm])
  return id
}

test('DB: new columns default to UNKNOWN / unclassified; CHECK constraints reject other values', async (t) => {
  await withDb(t, async (pool, projectId) => {
    const id = await insertRow(pool, await projectId())
    const row = (await pool.query('SELECT traffic_class_auto, traffic_class_reason, traffic_class_override, traffic_class_override_at FROM leads WHERE id = $1', [id])).rows[0]
    assert.deepEqual(row, { traffic_class_auto: 'UNKNOWN', traffic_class_reason: 'unclassified', traffic_class_override: null, traffic_class_override_at: null })
    await assert.rejects(pool.query(`UPDATE leads SET traffic_class_auto = 'MAYBE' WHERE id = $1`, [id]), /leads_traffic_class_auto_check/)
    await assert.rejects(pool.query(`UPDATE leads SET traffic_class_override = 'UNKNOWN' WHERE id = $1`, [id]), /leads_traffic_class_override_check/)
    await assert.rejects(pool.query(`UPDATE leads SET traffic_class_override = 'real' WHERE id = $1`, [id]), /leads_traffic_class_override_check/)
    await pool.query(`UPDATE leads SET traffic_class_auto = 'REAL', traffic_class_override = 'TEST' WHERE id = $1`, [id]) // valid values pass
  })
})

test('DB: insertLead stores the classification (legacy marker → TEST, arbitrary "test" and normal → UNKNOWN), intake still returns the lead', async (t) => {
  await withDb(t, async (pool, projectId) => {
    resetTrafficClassProbe()
    const pid = await projectId()
    const lead = (id: string, utmContent: string, utmTerm: string): LeadRow =>
      baseLead({ id, projectId: pid, name: 'n', email: '', phone: '+79990000000', utmContent, utmTerm, trafficClass: classifyLead({ project: 'driveset', utmContent, utmTerm }) })
    const cases: [string, string, string, string, string][] = [
      ['tc-a', 'a2_production_test', '', 'TEST', 'legacy_utm_marker'],
      ['tc-b', '', 'test_attribution', 'TEST', 'legacy_utm_marker'],
      ['tc-c', 'test', 'test', 'UNKNOWN', 'unclassified'],
      ['tc-d', '', '', 'UNKNOWN', 'unclassified'],
    ]
    for (const [id, content, term, auto, reason] of cases) {
      const r = await insertLead(pool, lead(`${id}-${Date.now()}`, content, term))
      assert.ok('row' in r && r.replay === false)
      assert.equal(r.row.traffic_class_auto, auto, id)
      assert.equal(r.row.traffic_class_reason, reason, id)
    }
    resetTrafficClassProbe()
  })
})

test('DB: the migration backfill marks only the historical driveset markers as TEST, leaves everything else UNKNOWN, is idempotent and never touches an override', async (t) => {
  await withDb(t, async (pool) => {
    const sql = readFileSync(new URL('../db/migrations/0016_leads_traffic_class.sql', import.meta.url), 'utf8')
    const backfill = sql.slice(sql.indexOf('UPDATE leads'))
    const client = await pool.connect()
    try {
      await client.query('BEGIN') // everything below is rolled back
      const clientId = (await client.query(`INSERT INTO clients (name) VALUES ('__test_backfill__') RETURNING id`)).rows[0].id as number
      const existing = await client.query(`SELECT id FROM projects WHERE slug = 'driveset'`)
      const driveset = existing.rows[0]?.id ?? (await client.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, 'DriveSet', '__bf.example', '', 'driveset') RETURNING id`, [clientId])).rows[0].id
      const other = (await client.query(`INSERT INTO projects (client_id, name, domain, sitemap_url, slug) VALUES ($1, 'Other', '__bf2.example', '', 'bf-other') RETURNING id`, [clientId])).rows[0].id
      const ins = async (id: string, project: number, content: string, term: string, auto = 'UNKNOWN', override: string | null = null) =>
        client.query(`INSERT INTO leads (id, project_id, name, email, utm_content, utm_term, traffic_class_auto, traffic_class_override) VALUES ($1, $2, 'n', '', $3, $4, $5, $6)`, [id, project, content, term, auto, override])
      await ins('bf-content', driveset, 'a2_production_test', '')
      await ins('bf-term', driveset, '', ' Test_Attribution ')
      await ins('bf-normal', driveset, '1922380925577514960', '---autotargeting')
      await ins('bf-testword', driveset, 'test', 'test')
      await ins('bf-other-project', other, 'a2_production_test', '') // a marker in another project is not our test
      await ins('bf-overridden', driveset, 'a2_production_test', '', 'UNKNOWN', 'REAL') // a human decision stays
      await client.query(backfill)
      await client.query(backfill) // idempotent
      const rows = (await client.query(`SELECT id, traffic_class_auto AS auto, traffic_class_reason AS reason, traffic_class_override AS override FROM leads WHERE id LIKE 'bf-%' ORDER BY id`)).rows
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
      assert.deepEqual([byId['bf-content'].auto, byId['bf-content'].reason], ['TEST', 'legacy_utm_marker'])
      assert.deepEqual([byId['bf-term'].auto, byId['bf-term'].reason], ['TEST', 'legacy_utm_marker'])
      for (const id of ['bf-normal', 'bf-testword', 'bf-other-project']) assert.deepEqual([byId[id].auto, byId[id].reason], ['UNKNOWN', 'unclassified'], id)
      assert.equal(byId['bf-overridden'].override, 'REAL')
      assert.equal(effectiveTrafficClass(byId['bf-overridden'].auto, byId['bf-overridden'].override), 'REAL') // override still wins
      assert.ok(rows.every((r) => r.auto !== 'REAL')) // nothing promoted to REAL
      await client.query('ROLLBACK')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })
})

test('DB: reader returns the effective class; the override primitive sets, replaces and clears it', async (t) => {
  await withDb(t, async (pool, projectId) => {
    const pid = await projectId()
    const slug = `tc-${Date.now()}`
    await pool.query('UPDATE projects SET slug = $2 WHERE id = $1', [pid, slug])
    const id = await insertRow(pool, pid)
    await pool.query(`UPDATE leads SET traffic_class_auto = 'TEST', traffic_class_reason = 'legacy_utm_marker' WHERE id = $1`, [id])
    const read = async () => {
      const r = await readLeadSignalsForPeriod(pool, { project: slug, period: { ...period, fromUtc: '2000-01-01T00:00:00Z', toUtcExclusive: '2100-01-01T00:00:00Z' } }, 2000, { withTrafficClass: true })
      assert.ok(!('error' in r))
      return r.signals[0]
    }
    assert.equal((await read()).trafficClass, 'TEST')
    assert.equal(await setTrafficClassOverride(pool, id, 'REAL'), true)
    const overridden = await read()
    assert.deepEqual([overridden.trafficClassAuto, overridden.trafficClassOverride, overridden.trafficClass], ['TEST', 'REAL', 'REAL'])
    assert.ok((await pool.query('SELECT traffic_class_override_at FROM leads WHERE id = $1', [id])).rows[0].traffic_class_override_at)
    assert.equal(await setTrafficClassOverride(pool, id, null), true)
    assert.equal((await read()).trafficClass, 'TEST') // cleared → the automatic class again
    assert.equal((await pool.query('SELECT traffic_class_override_at FROM leads WHERE id = $1', [id])).rows[0].traffic_class_override_at, null)
    assert.equal(await setTrafficClassOverride(pool, 'no-such-lead', 'TEST'), false)
  })
})
