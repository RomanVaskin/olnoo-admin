import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDirectClient,
  directConfigFromEnv,
  directErrorHttpStatus,
  DirectApiError,
  isReadOnlyDirectMethod,
  resolveCampaignId,
} from './yandex-direct.ts'
import { DAILY_FIELDS, SEARCH_QUERY_FIELDS, SEARCH_QUERY_FIELDS_WITHOUT_CATEGORY } from './yandex-direct-report.ts'

const TOKEN = 'y0_SUPER_SECRET_TOKEN'
const CID = 714796268
const config = { token: TOKEN, campaignIds: [CID] }

type Call = { url: string; headers: Record<string, string>; body: string }
type Handler = (call: Call, n: number) => Response | Error

/** Scripted global fetch (same approach as fetch-retry.test.ts); records every request. */
async function withFetch<T>(handler: Handler, fn: (calls: Call[]) => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body ?? '') }
    calls.push(call)
    const out = handler(call, calls.length)
    if (out instanceof Error) throw out
    return out
  }) as typeof fetch
  try {
    return await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

/** Client with a fake clock: sleeping advances time instead of waiting. */
function client() {
  let t = Date.parse('2026-10-04T10:00:00Z')
  const sleeps: number[] = []
  const c = createDirectClient(config, {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms)
      t += ms
    },
    retry: { retryDelayMs: 0 },
  })
  return { c, sleeps }
}

const campaignJson = () =>
  new Response(JSON.stringify({ result: { Campaigns: [{ Id: CID, Name: 'DriveSet', State: 'ON', Status: 'ACCEPTED', Type: 'TEXT_CAMPAIGN', StartDate: '2026-09-25' }] } }), {
    status: 200,
    headers: { RequestId: 'req-campaign', Units: '10/20828/64000' },
  })
const tsv = (fields: string[], ...rows: string[][]) => [`"report"`, fields.join('\t'), ...rows.map((r) => r.join('\t')), `Total rows: ${rows.length}`].join('\n')
const dailyTsv = () => tsv(DAILY_FIELDS, ['2026-10-01', String(CID), '120', '9', '1234500000'], ['2026-10-02', String(CID), '100', '1', '100000000'])
const queryTsv = () => tsv(SEARCH_QUERY_FIELDS, [String(CID), '10', 'ppf цена', '---autotargeting', 'AUTOTARGETING', 'BROADER', '80', '5', '900000000'])
const tsvResponse = (text: string, status = 200, headers: Record<string, string> = {}) => new Response(text, { status, headers: { 'Content-Type': 'text/tab-separated-values', ...headers } })
const errBody = (code: number, detail = '', requestId = 'req-err') => JSON.stringify({ error: { error_code: code, error_string: 'Err', error_detail: detail, request_id: requestId } })
const isReports = (c: Call) => c.url.endsWith('/reports')
const reportType = (c: Call) => JSON.parse(c.body).params.ReportType as string

test('200: campaigns.get + daily + search queries → payload; only read endpoints, Bearer token, no Client-Login', async () => {
  const { c } = client()
  await withFetch(
    (call) => (!isReports(call) ? campaignJson() : reportType(call) === 'CAMPAIGN_PERFORMANCE_REPORT' ? tsvResponse(dailyTsv()) : tsvResponse(queryTsv())),
    async (calls) => {
      const payload = await c.observe(CID, 7)
      assert.equal(payload.campaign.id, CID)
      assert.equal(payload.campaign.name, 'DriveSet')
      assert.deepEqual(payload.campaign.totals, { impressions: 220, clicks: 10, spend: 1334.5, cpc: 133.45 })
      assert.equal(payload.daily.length, 2)
      assert.equal(payload.searchQueries[0].criteriaType, 'AUTOTARGETING')
      assert.equal(payload.meta.units, '10/20828/64000')
      assert.ok(payload.meta.requestIds.includes('req-campaign'))
      assert.deepEqual(payload.period, { from: '2026-09-27', to: '2026-10-03' })

      assert.equal(calls.length, 3) // sequential, no fan-out
      assert.deepEqual(calls.map((x) => x.url), [
        'https://api.direct.yandex.com/json/v501/campaigns',
        'https://api.direct.yandex.com/json/v501/reports',
        'https://api.direct.yandex.com/json/v501/reports',
      ])
      assert.equal(JSON.parse(calls[0].body).method, 'get')
      for (const call of calls) {
        assert.equal(call.headers.Authorization, `Bearer ${TOKEN}`)
        assert.ok(!('Client-Login' in call.headers))
        assert.ok(!call.url.includes(TOKEN) && !call.body.includes(TOKEN))
      }
    },
  )
})

for (const status of [201, 202]) {
  test(`${status} → wait retryIn → the SAME request again → 200`, async () => {
    const { c, sleeps } = client()
    let dailyAttempts = 0
    await withFetch(
      (call) => {
        if (!isReports(call)) return campaignJson()
        if (reportType(call) === 'SEARCH_QUERY_PERFORMANCE_REPORT') return tsvResponse(queryTsv())
        dailyAttempts++
        return dailyAttempts === 1 ? tsvResponse('', status, { retryIn: '7' }) : tsvResponse(dailyTsv())
      },
      async (calls) => {
        const payload = await c.observe(CID, 7)
        assert.equal(payload.daily.length, 2)
        const dailyCalls = calls.filter((x) => isReports(x) && reportType(x) === 'CAMPAIGN_PERFORMANCE_REPORT')
        assert.equal(dailyCalls.length, 2)
        assert.equal(dailyCalls[0].body, dailyCalls[1].body) // identical definition and ReportName
        assert.ok(sleeps.includes(7_000)) // honoured retryIn
      },
    )
  })
}

test('a report that never becomes ready ends with report_timeout after a bounded number of polls', async () => {
  const { c } = client()
  await withFetch(
    (call) => (isReports(call) ? tsvResponse('', 202, { retryIn: '10' }) : campaignJson()),
    async (calls) => {
      await assert.rejects(c.observe(CID, 7), (e: unknown) => e instanceof DirectApiError && e.kind === 'report_timeout')
      const reportPosts = calls.filter(isReports).length
      assert.ok(reportPosts >= 2 && reportPosts <= 12, `report posts: ${reportPosts}`)
    },
  )
})

test('Direct errors are normalised (kind, Direct code, RequestId) and mapped to HTTP statuses', async () => {
  const cases: [number, string, number][] = [
    [53, 'auth', 502],
    [54, 'rights', 502],
    [152, 'quota', 429],
    [8000, 'request', 502],
  ]
  for (const [code, kind, http] of cases) {
    const { c } = client()
    await withFetch(
      () => new Response(errBody(code, 'details', `req-${code}`), { status: 200 }),
      async () => {
        await assert.rejects(c.getCampaign(CID), (e: unknown) => {
          assert.ok(e instanceof DirectApiError)
          assert.equal(e.kind, kind)
          assert.equal(e.directCode, code)
          assert.equal(e.requestId, `req-${code}`)
          assert.equal(directErrorHttpStatus(e.kind), http)
          return true
        })
      },
    )
  }
  assert.equal(directErrorHttpStatus('report_timeout'), 504)
  assert.equal(directErrorHttpStatus('not_configured'), 503)
  assert.equal(directErrorHttpStatus('forbidden_campaign'), 403)
})

test('Direct 400 on a report is an error; transient 52 is retried and then succeeds', async () => {
  const { c } = client()
  let n = 0
  await withFetch(
    () => (++n === 1 ? new Response(errBody(52), { status: 200 }) : campaignJson()),
    async (calls) => {
      assert.equal((await c.getCampaign(CID)).id, CID)
      assert.equal(calls.length, 2)
    },
  )
  const second = client()
  await withFetch(
    (call) => (isReports(call) ? new Response(errBody(4000, 'bad report', 'req-400'), { status: 400 }) : campaignJson()),
    async () => {
      await assert.rejects(second.c.observe(CID, 7), (e: unknown) => e instanceof DirectApiError && e.kind === 'request' && e.requestId === 'req-400')
    },
  )
})

test('TargetingCategory (deprecated) rejected by Direct → the search report is re-asked without it', async () => {
  const { c } = client()
  await withFetch(
    (call) => {
      if (!isReports(call)) return campaignJson()
      if (reportType(call) === 'CAMPAIGN_PERFORMANCE_REPORT') return tsvResponse(dailyTsv())
      const fields: string[] = JSON.parse(call.body).params.FieldNames
      if (fields.includes('TargetingCategory')) return new Response(errBody(8000, 'Field TargetingCategory is not supported'), { status: 400 })
      return tsvResponse(tsv(SEARCH_QUERY_FIELDS_WITHOUT_CATEGORY, [String(CID), '10', 'q', 'q', 'KEYWORD', '5', '1', '10000000']))
    },
    async () => {
      const payload = await c.observe(CID, 7)
      assert.equal(payload.searchQueries.length, 1)
      assert.equal('targetingCategory' in payload.searchQueries[0], false)
    },
  )
})

test('allowlist: only configured campaign ids; no arbitrary campaignId', () => {
  assert.equal(resolveCampaignId(null, [CID]), CID)
  assert.equal(resolveCampaignId('714796268', [CID]), CID)
  for (const bad of ['1', '714796269', 'abc', '714796268 ', '-714796268', '714796268.0']) {
    assert.throws(() => resolveCampaignId(bad, [CID]), (e: unknown) => e instanceof DirectApiError && e.kind === 'forbidden_campaign')
  }
  assert.throws(() => resolveCampaignId(null, [1, 2]), (e: unknown) => e instanceof DirectApiError && e.kind === 'request')

  assert.deepEqual(directConfigFromEnv({ YANDEX_DIRECT_TOKEN: 't', YANDEX_DIRECT_CAMPAIGN_IDS: '714796268' }), { token: 't', campaignIds: [714796268] })
  assert.equal(directConfigFromEnv({ YANDEX_DIRECT_CAMPAIGN_IDS: '714796268' }), null)
  assert.equal(directConfigFromEnv({ YANDEX_DIRECT_TOKEN: 't' }), null)
  assert.equal(directConfigFromEnv({ YANDEX_DIRECT_TOKEN: 't', YANDEX_DIRECT_CAMPAIGN_IDS: '714796268,abc' }), null)
})

test('the client is read-only: only campaigns.get is representable', () => {
  assert.equal(isReadOnlyDirectMethod('campaigns', 'get'), true)
  for (const method of ['add', 'update', 'delete', 'suspend', 'resume', 'archive', 'unarchive', 'setBids']) {
    assert.equal(isReadOnlyDirectMethod('campaigns', method), false)
  }
  for (const service of ['keywords', 'bids', 'ads', 'adgroups', 'reports']) assert.equal(isReadOnlyDirectMethod(service, 'get'), false)
})

test('the OAuth token never appears in errors, even if Direct or the network echoes it', async () => {
  // Direct echoes the token inside the error text
  const echo = client()
  await withFetch(
    () => new Response(errBody(8000, `bad header Authorization: Bearer ${TOKEN}`), { status: 200 }),
    async () => {
      await assert.rejects(echo.c.getCampaign(CID), (e: unknown) => {
        assert.ok(e instanceof DirectApiError)
        const dump = `${e.message}\n${e.stack}\n${JSON.stringify(e)}`
        assert.ok(!dump.includes(TOKEN))
        assert.ok(e.message.includes('[redacted]'))
        return true
      })
    },
  )
  // The network layer fails with a message containing the token
  const net = client()
  await withFetch(
    () => Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { code: `ECONN ${TOKEN}` } }),
    async () => {
      await assert.rejects(net.c.getCampaign(CID), (e: unknown) => {
        assert.ok(e instanceof DirectApiError && e.kind === 'network')
        assert.ok(!`${e.message}${e.stack}${JSON.stringify(e)}`.includes(TOKEN))
        return true
      })
    },
  )
  // A non-JSON error body is never copied into the error
  const raw = client()
  await withFetch(
    () => new Response(`<html>${TOKEN}</html>`, { status: 400 }),
    async () => {
      await assert.rejects(raw.c.getCampaign(CID), (e: unknown) => e instanceof DirectApiError && !e.message.includes(TOKEN) && !e.message.includes('<html>'))
    },
  )
})
