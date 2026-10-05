import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createMetrikaClient, MetrikaApiError, metrikaConfigFromEnv, metrikaErrorHttpStatus, resolveMetrikaProject } from './yandex-metrika.ts'
import { OBSERVED_GOALS } from './yandex-metrika-report.ts'
import { resolveObserverPeriod } from './observer-period.ts'

const TOKEN = 'y0_METRIKA_SECRET_TOKEN'
const NOW = new Date('2026-10-05T09:00:00Z')
const q = (s: string) => resolveObserverPeriod(new URLSearchParams(s), NOW) as Exclude<ReturnType<typeof resolveObserverPeriod>, { error: string }>

type Call = { url: URL; init: RequestInit }
type Handler = (url: URL, n: number) => Response | Error

async function withFetch<T>(handler: Handler, fn: (calls: Call[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ url, init: init ?? {} })
    const out = handler(url, calls.length)
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const client = () => createMetrikaClient({ token: TOKEN }, { retry: { retryDelayMs: 0 }, now: () => NOW })

const managedGoals = (omit: number[] = []) => ({
  goals: OBSERVED_GOALS.filter((g) => !omit.includes(g.id)).map((g) => ({ id: g.id, name: g.name, type: 'action', conditions: [{ type: 'exact', url: g.event }] })),
})

/** Metrika-like answer for any stat query: one value per requested metric, one row per dimension tuple. */
function stat(url: URL, overrides: Record<string, unknown> = {}) {
  const metrics = (url.searchParams.get('metrics') ?? '').split(',')
  const dims = (url.searchParams.get('dimensions') ?? '').split(',').filter(Boolean)
  const value = (m: string) => (m.endsWith('bounceRate') ? 60.5 : m.endsWith('avgVisitDurationSeconds') ? 80.25 : m.endsWith('users') ? 8 : m.includes('reaches') ? 5 : m.includes('goal') ? 3 : 10)
  const values = metrics.map(value)
  const rows = dims.length
    ? [{ dimensions: dims.map((d) => ({ name: d === 'ym:s:date' ? url.searchParams.get('date1') : `v-${d}`, id: '1' })), metrics: values }]
    : [{ dimensions: [], metrics: values }]
  return { query: {}, data: rows, total_rows: rows.length, totals: values, sampled: false, sample_share: 1, data_lag: 12, ...overrides }
}

const happy: Handler = (url) => (url.pathname.includes('/management/') ? json(managedGoals()) : json(stat(url)))

test('config: token from YANDEX_METRIKA_TOKEN only; missing or odd token = not configured', () => {
  assert.deepEqual(metrikaConfigFromEnv({ YANDEX_METRIKA_TOKEN: ` ${TOKEN} ` }), { token: TOKEN })
  assert.equal(metrikaConfigFromEnv({}), null)
  assert.equal(metrikaConfigFromEnv({ YANDEX_DIRECT_TOKEN: TOKEN }), null) // never falls back to the Direct token
  assert.equal(metrikaConfigFromEnv({ YANDEX_METRIKA_TOKEN: 'has space' }), null)
  assert.equal(metrikaErrorHttpStatus('not_configured'), 503)
})

test('project: driveset → counter 113053562; anything else is a controlled error', () => {
  assert.deepEqual(resolveMetrikaProject('driveset'), { counterId: 113053562, timezone: 'Europe/Moscow' })
  for (const slug of ['olnoo', 'all', '__proto__', 'constructor', 'toString']) {
    assert.throws(() => resolveMetrikaProject(slug), (e) => e instanceof MetrikaApiError && e.kind === 'unknown_project')
  }
  assert.equal(metrikaErrorHttpStatus('unknown_project'), 404)
})

test('observe: only GET, only the allowed hosts/paths, OAuth header, no visitor-level dimension, no Direct token', async () => {
  await withFetch(happy, async (calls) => {
    const payload = await client().observe('driveset', q('period=last7'))
    assert.equal(calls.length, 9) // goal list + daily + goals + sources + utm + 4 Direct breakdowns
    assert.equal(payload.meta.requests, 9)
    for (const { url, init } of calls) {
      assert.equal(init.method, 'GET')
      assert.equal(url.origin, 'https://api-metrika.yandex.net')
      assert.ok(url.pathname === '/stat/v1/data' || url.pathname === '/management/v1/counter/113053562/goals')
      assert.equal((init.headers as Record<string, string>).Authorization, `OAuth ${TOKEN}`)
      assert.ok(!url.toString().includes(TOKEN)) // never in the URL
      if (url.pathname === '/stat/v1/data') {
        assert.equal(url.searchParams.get('ids'), '113053562')
        assert.equal(url.searchParams.get('date1'), '2026-09-28')
        assert.equal(url.searchParams.get('date2'), '2026-10-04')
        assert.doesNotMatch(url.search, /clientID|yclid|userID|visitID/i)
      }
    }
    const text = JSON.stringify(payload)
    assert.doesNotMatch(text, /clientID|client_id|yclid|userID|visitID|"phone"|"contact"/i)
    assert.ok(!text.includes(TOKEN))
  })
})

test('observe: today is incomplete and says so; historical periods are complete', async () => {
  await withFetch(happy, async () => {
    const today = await client().observe('driveset', q('period=today'))
    assert.equal(today.period.complete, false)
    assert.ok(today.warnings.some((w) => w.code === 'incomplete_period'))
    const past = await client().observe('driveset', q('period=yesterday'))
    assert.equal(past.period.complete, true)
    assert.ok(!past.warnings.some((w) => w.code === 'incomplete_period'))
  })
})

test('goals: reaches and visitsWithGoal come from different metrics; reaches may exceed visits', async () => {
  await withFetch(
    (url) =>
      url.pathname.includes('/management/')
        ? json(managedGoals())
        : url.searchParams.get('metrics')?.includes('goal664270022')
          ? json({ data: [{ dimensions: [], metrics: OBSERVED_GOALS.flatMap((g) => [g.event === 'lead_submit' ? 3 : 7, g.event === 'lead_submit' ? 1 : 4]) }], totals: [], sampled: false })
          : json(stat(url)),
    async (calls) => {
      const payload = await client().observe('driveset', q('period=yesterday'))
      const goalCall = calls.find((c) => c.url.searchParams.get('metrics')?.includes('goal664270022'))
      assert.match(goalCall!.url.searchParams.get('metrics')!, /ym:s:goal663848261reaches,ym:s:goal663848261visits/)
      const lead = payload.goals.find((g) => g.event === 'lead_submit')!
      assert.deepEqual([lead.reaches, lead.visitsWithGoal], [3, 1]) // 3 reaches in 1 visit: allowed
      const start = payload.funnel.find((s) => s.step === 'quiz_start')!
      assert.deepEqual([start.visits, start.reaches], [4, 7]) // funnel uses visits; reaches is diagnostic
    },
  )
})

test('missing goal: a warning, the goal is not requested and the answer is still 200-shaped', async () => {
  const lead = 663848261
  await withFetch(
    (url) => (url.pathname.includes('/management/') ? json(managedGoals([lead])) : json(stat(url))),
    async (calls) => {
      const payload = await client().observe('driveset', q('period=yesterday'))
      assert.ok(payload.warnings.some((w) => w.code === 'goal_missing' && w.message.includes(String(lead))))
      assert.equal(payload.goals.find((g) => g.id === lead)!.found, false)
      assert.ok(calls.filter((c) => c.url.pathname === '/stat/v1/data').every((c) => !c.url.searchParams.get('metrics')!.includes(String(lead))))
      assert.equal(payload.sources[0].leadSubmitVisits, null)
    },
  )
})

test('goal list unavailable or with a changed condition → warnings, not failures', async () => {
  await withFetch((url) => (url.pathname.includes('/management/') ? json({ message: 'nope' }, 403) : json(stat(url))), async () => {
    const payload = await client().observe('driveset', q('period=yesterday'))
    assert.ok(payload.warnings.some((w) => w.code === 'goal_list_unavailable'))
  })
  const changed = { goals: managedGoals().goals.map((g) => (g.id === 664270022 ? { ...g, conditions: [{ type: 'exact', url: 'other' }] } : g)) }
  await withFetch((url) => (url.pathname.includes('/management/') ? json(changed) : json(stat(url))), async () => {
    const payload = await client().observe('driveset', q('period=yesterday'))
    assert.ok(payload.warnings.some((w) => w.code === 'goal_condition_mismatch'))
  })
})

test('a rejected breakdown dimension is a warning with an empty list; other failures stay fatal', async () => {
  await withFetch(
    (url) =>
      url.pathname.includes('/management/')
        ? json(managedGoals())
        : url.searchParams.get('dimensions') === 'ym:s:lastDirectSearchPhrase'
          ? json({ errors: [{ error_type: 'invalid_parameter', message: 'bad dimension' }], code: 400, message: 'bad dimension' }, 400)
          : json(stat(url)),
    async () => {
      const payload = await client().observe('driveset', q('period=yesterday'))
      assert.deepEqual(payload.direct.searchPhrases, [])
      assert.ok(payload.warnings.some((w) => w.code === 'dimension_unavailable' && w.message.includes('direct.searchPhrases')))
      assert.ok(payload.direct.campaigns.length > 0)
    },
  )
})

test('sampling is reported: meta.sampled, share and a warning', async () => {
  await withFetch(
    (url) => (url.pathname.includes('/management/') ? json(managedGoals()) : json(stat(url, url.searchParams.get('dimensions') === 'ym:s:lastsignTrafficSource' ? { sampled: true, sample_share: 0.4 } : {}))),
    async () => {
      const payload = await client().observe('driveset', q('period=yesterday'))
      assert.equal(payload.meta.sampled, true)
      assert.equal(payload.meta.sampling.minSampleShare, 0.4)
      assert.ok(payload.warnings.some((w) => w.code === 'sampled'))
    },
  )
  await withFetch(happy, async () => assert.equal((await client().observe('driveset', q('period=yesterday'))).meta.sampled, false))
})

test('errors: auth, rights, quota, upstream, timeout/network, unreadable — normalised, token never in the message', async () => {
  const cases: [Response | Error, string][] = [
    [json({ errors: [{ error_type: 'invalid_token', message: `bad ${TOKEN}` }], code: 401 }, 401), 'auth'],
    [json({ errors: [{ error_type: 'access_denied', message: 'no access' }], code: 403 }, 403), 'rights'],
    [json({ errors: [{ error_type: 'quota', message: 'limit' }], code: 429 }, 429), 'quota'],
    [new Response('<html>oops</html>', { status: 503 }), 'upstream'],
    [Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }), 'network'],
    [new Response('not json', { status: 200 }), 'report_format'],
  ]
  for (const [out, kind] of cases) {
    // management goal list degrades to a warning, so the first failing call that matters is the daily report
    await withFetch(
      (url) => (url.pathname.includes('/management/') ? json(managedGoals()) : out instanceof Response ? out.clone() : out),
      async () => {
        await assert.rejects(
          () => client().observe('driveset', q('period=yesterday')),
          (e: unknown) => {
            assert.ok(e instanceof MetrikaApiError, `expected MetrikaApiError for ${kind}`)
            assert.equal(e.kind, kind)
            assert.ok(!e.message.includes(TOKEN) && !JSON.stringify(e).includes(TOKEN))
            return true
          },
        )
      },
    )
  }
})

test('read-only: the client cannot send other URLs, dimensions or metrics', async () => {
  const c = client()
  await withFetch(happy, async (calls) => {
    const period = q('period=yesterday')
    for (const query of [
      { dimensions: ['ym:s:clientID'], metrics: ['ym:s:visits'], limit: 5 },
      { dimensions: ['ym:s:lastsignUTMSource'], metrics: ['ym:s:clientIDs'], limit: 5 },
      { dimensions: ['ym:s:yclid'], metrics: ['ym:s:visits'], limit: 5 },
    ]) {
      await assert.rejects(() => c.stat(query, 113053562, period), (e) => e instanceof MetrikaApiError && e.kind === 'request')
    }
    assert.equal(calls.length, 0) // nothing was sent
  })
  const src = readFileSync(new URL('./yandex-metrika.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /method:\s*'(POST|PUT|PATCH|DELETE)'/)
  assert.doesNotMatch(src, /YANDEX_DIRECT_TOKEN/)
  assert.doesNotMatch(src, /logs-api|\/logrequests/i)
})

test('route: exports GET only', () => {
  const route = readFileSync(new URL('../app/api/metrika/observer/route.ts', import.meta.url), 'utf8')
  assert.deepEqual([...route.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]), ['GET'])
  assert.doesNotMatch(route, /console\.(log|error)\([^)]*(token|config)/i)
})

test('extras: 3 read-only requests (daily goals, Direct-click segment by id, explicit test segment); a failing one is a warning, not a failure', async () => {
  const rules = { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'] }
  const answer = (url: URL) => {
    const dims = url.searchParams.get('dimensions')
    if (dims === 'ym:s:date') return json({ data: [{ dimensions: [{ name: '2026-10-05' }], metrics: [4, 1] }], totals: [4, 1], sampled: false })
    if (dims === 'ym:s:lastDirectClickOrder') {
      const m = (url.searchParams.get('metrics') ?? '').split(',').map(() => 2)
      return json({ data: [{ dimensions: [{ id: '714796268', name: 'Campaign' }], metrics: m }], totals: m, sampled: true })
    }
    return json({ data: [{ dimensions: [{ name: 'a2_production_test' }, { name: 'test_attribution' }], metrics: [1, 1, 1, 1, 1, 1, 0, 0, 0, 3] }], totals: [], sampled: false })
  }
  await withFetch(answer, async (calls) => {
    const extras = await client().observeUnifiedExtras('driveset', q('period=today'), 714796268, rules)
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map((c) => c.url.searchParams.get('dimensions')), ['ym:s:date', 'ym:s:lastDirectClickOrder', 'ym:s:lastsignUTMContent,ym:s:lastsignUTMTerm'])
    assert.equal(calls[2].url.searchParams.get('filters'), "ym:s:lastsignUTMContent=='a2_production_test' OR ym:s:lastsignUTMTerm=='test_attribution'")
    assert.ok(calls.every((c) => c.init.method === 'GET' && !c.url.search.match(/clientID|yclid/i)))
    assert.deepEqual(extras.dailyGoals, [{ date: '2026-10-05', quizStartVisits: 4, leadSubmitVisits: 1 }])
    assert.deepEqual([extras.directSegment!.found, extras.directSegment!.visits], [true, 2])
    assert.equal(extras.testSegment!.visits, 1)
    assert.equal(extras.sampled, true)
    assert.deepEqual(extras.warnings, [])
  })

  // one failing read → warning + null for that block only
  await withFetch((url) => (url.searchParams.get('dimensions') === 'ym:s:lastDirectClickOrder' ? json({ errors: [{ error_type: 'invalid_parameter', message: 'x' }] }, 400) : answer(url)), async () => {
    const extras = await client().observeUnifiedExtras('driveset', q('period=today'), 714796268, rules)
    assert.equal(extras.directSegment, null)
    assert.ok(extras.dailyGoals && extras.testSegment)
    assert.ok(extras.warnings.some((w) => w.code === 'extras_unavailable' && w.message.startsWith('directSegment')))
  })

  // no rules → no test request, zero test segment
  await withFetch(answer, async (calls) => {
    const extras = await client().observeUnifiedExtras('driveset', q('period=today'), 714796268, { utmContent: [], utmTerm: [] })
    assert.equal(calls.length, 2)
    assert.equal(extras.testSegment!.visits, 0)
    assert.equal(extras.testSegment!.goalVisits.lead_submit, 0)
  })
})

test('extras: the client refuses a filter outside the exact-UTM shape', async () => {
  const c = client()
  await withFetch(happy, async (calls) => {
    await assert.rejects(
      () => c.stat({ dimensions: ['ym:s:lastsignUTMContent'], metrics: ['ym:s:visits'], limit: 5, filters: "ym:s:clientID=='1'" }, 113053562, q('period=today')),
      (e) => e instanceof MetrikaApiError && e.kind === 'request',
    )
    assert.equal(calls.length, 0)
  })
})
