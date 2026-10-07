import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  handleMcpRequest,
  SUMMARY_INPUT_SHAPE,
  SUMMARY_PERIODS,
  SUMMARY_TOOL_NAME,
  toSummaryDto,
  type SummaryDto,
  type SummaryPeriod,
} from './mcp-summary.ts'

// A Unified-shaped payload with extra (heavy / sensitive-looking) fields the DTO must drop.
const unified = (over: Record<string, unknown> = {}) =>
  ({
    project: 'driveset',
    period: { from: '2026-10-05', to: '2026-10-05', timezone: 'Europe/Moscow', complete: false, preset: 'today' },
    direct: { status: 'ok', error: { kind: 'x', message: 'secret-ish' }, complete: false, campaign: { id: 1, name: 'C' }, impressions: 3000, clicks: 150, spend: 7500, ctr: 5, cpc: 50, includesVat: true },
    metrika: { status: 'ok', visits: 108, users: 90, bounceRate: 1, sampled: false },
    crm: { status: 'ok', leads: 5, leadsTotal: 5, leadsReal: 3, leadsTest: 1, leadsUnknown: 1, testLeads: 1, leadsDirect: 3, leadsDirectReal: 2, leadsDirectTest: 0, leadsDirectUnknown: 1, byStatus: { New: 4 }, truncated: false },
    funnel: { quizStartVisits: 1 }, daily: [{ date: 'x' }], breakdowns: { searchQueries: [{ query: 'купить' }] }, attribution: {}, testTraffic: { detected: true },
    conversions: { cpl: { value: null, reason: 'period_incomplete' }, clickToVisitPct: { value: 44 } },
    warnings: [{ code: 'incomplete_period', message: 'partial day' }, { code: 'source_partial', message: 'metrika partial', source: 'metrika', phone: '+79990000000' }],
    meta: { generatedAt: '2026-10-05T09:00:00.000Z', sources: {}, limitations: ['x'] },
    ...over,
  }) as never

const dto = (over: Record<string, unknown> = {}) => toSummaryDto(unified(over))

// ---- DTO ----------------------------------------------------------------------------------------------------

test('DTO: exactly the whitelisted fields, nothing else', () => {
  const d = dto()
  assert.deepEqual(Object.keys(d), ['period', 'direct', 'metrika', 'crm', 'conversions', 'warnings', 'generatedAt'])
  assert.deepEqual(d.period, { from: '2026-10-05', to: '2026-10-05', complete: false, preset: 'today' })
  assert.deepEqual(d.direct, { status: 'ok', impressions: 3000, clicks: 150, spend: 7500, cpc: 50, ctr: 5 })
  assert.deepEqual(d.metrika, { status: 'ok', visits: 108 })
  assert.deepEqual(d.crm, { status: 'ok', leadsTotal: 5, leadsReal: 3, leadsTest: 1, leadsUnknown: 1, leadsDirectReal: 2 })
  assert.deepEqual(d.conversions, { cpl: { value: null, reason: 'period_incomplete' } })
  assert.deepEqual(d.warnings, [{ code: 'incomplete_period', message: 'partial day' }, { code: 'source_partial', message: 'metrika partial', source: 'metrika' }])
  assert.equal(d.generatedAt, '2026-10-05T09:00:00.000Z')
})

test('DTO: no personal data, search queries, breakdowns or error details', () => {
  const text = JSON.stringify(dto())
  for (const word of ['name', 'phone', 'contact', 'message":"secret', 'clientId', 'yclid', 'searchQueries', 'breakdowns', 'funnel', 'daily', 'attribution', 'testTraffic', 'secret-ish', '79990000000', 'купить', 'byStatus', 'error']) {
    assert.ok(!text.includes(word) || word === 'message":"secret', word)
  }
  assert.ok(!/"(name|phone|contact|clientId|yclid)"/.test(text))
})

test('DTO: null stays null (never 0); partial / unavailable statuses are kept', () => {
  const d = dto({
    direct: { status: 'unavailable', impressions: null, clicks: null, spend: null, ctr: null, cpc: null },
    metrika: { status: 'partial', visits: null },
    crm: { status: 'ok', leadsTotal: 0, leadsReal: 0, leadsTest: 0, leadsUnknown: 0, leadsDirectReal: 0 },
    conversions: { cpl: { value: null, reason: 'no_attributed_leads' } },
  })
  assert.deepEqual(d.direct, { status: 'unavailable', impressions: null, clicks: null, spend: null, cpc: null, ctr: null })
  assert.deepEqual(d.metrika, { status: 'partial', visits: null })
  assert.equal(d.crm.leadsReal, 0) // a real zero is kept as zero
  assert.deepEqual(d.conversions.cpl, { value: null, reason: 'no_attributed_leads' })
  const missing = dto({ metrika: {}, direct: {}, crm: {} })
  assert.deepEqual([missing.metrika.visits, missing.direct.spend, missing.crm.leadsReal], [null, null, null])
  assert.equal(missing.metrika.status, 'unavailable')
})

// ---- MCP protocol (real SDK, in-memory handler) ----------------------------------------------------------

const HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
const rpc = (body: unknown) => new Request('http://x/api/mcp', { method: 'POST', headers: HEADERS, body: JSON.stringify(body) })
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }

async function call(body: unknown, getSummary: (p: SummaryPeriod) => Promise<SummaryDto> = async () => dto()) {
  const res = await handleMcpRequest(rpc(body), getSummary)
  return { res, json: res.status === 202 ? null : ((await res.json()) as any) }
}

test('initialize works statelessly; every answer is no-store', async () => {
  const { res, json } = await call(INIT)
  assert.equal(res.status, 200)
  assert.equal(json.result.serverInfo.name, 'olnoo')
  assert.equal(res.headers.get('cache-control'), 'no-store')
  assert.equal(res.headers.get('mcp-session-id'), null)
})

test('tools/list: exactly one tool, read-only, input is only `period` (default today), no project parameter', async () => {
  const { json } = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const tools = json.result.tools
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, SUMMARY_TOOL_NAME)
  assert.equal(tools[0].annotations.readOnlyHint, true)
  assert.equal(tools[0].annotations.destructiveHint, false)
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['period'])
  assert.deepEqual(tools[0].inputSchema.properties.period.enum, [...SUMMARY_PERIODS])
  assert.equal(tools[0].inputSchema.properties.period.default, 'today')
  assert.deepEqual(Object.keys(SUMMARY_INPUT_SHAPE), ['period'])
  assert.ok(!/create|update|delete|write|send|post/i.test(tools[0].name)) // no write-looking tools
})

test('tools/call: today / yesterday / last7 pass; the period reaches the loader; default is today', async () => {
  for (const period of SUMMARY_PERIODS) {
    const seen: string[] = []
    const { json } = await call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: SUMMARY_TOOL_NAME, arguments: { period } } }, async (p) => (seen.push(p), dto()))
    assert.deepEqual(seen, [period])
    assert.equal(json.result.isError, undefined)
    assert.equal(JSON.parse(json.result.content[0].text).crm.leadsDirectReal, 2)
  }
  const seen: string[] = []
  await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: SUMMARY_TOOL_NAME, arguments: {} } }, async (p) => (seen.push(p), dto()))
  await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: SUMMARY_TOOL_NAME } }, async (p) => (seen.push(p), dto()))
  assert.deepEqual(seen, ['today', 'today'])
})

test('tools/call: other periods and unknown tools are rejected without loading; extra `project` is ignored (always driveset)', async () => {
  let loads = 0
  const loader = async () => (loads++, dto())
  for (const period of ['lastmonth', '2026-10-01', '', 7, null]) {
    const { json } = await call({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: SUMMARY_TOOL_NAME, arguments: { period } } }, loader)
    assert.ok(json.error || json.result?.isError, String(period))
  }
  const unknown = await call({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } }, loader)
  assert.ok(unknown.json.error || unknown.json.result?.isError)
  assert.equal(loads, 0)
  await call({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: SUMMARY_TOOL_NAME, arguments: { period: 'today', project: 'olnoo' } } }, loader)
  assert.equal(loads, 1)
})

test('tools/call: a failing loader gives a generic tool error without any detail', async () => {
  const { json } = await call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: SUMMARY_TOOL_NAME, arguments: { period: 'today' } } }, async () => {
    throw new Error('token=abc123 https://internal/secret')
  })
  assert.equal(json.result.isError, true)
  assert.ok(!JSON.stringify(json).includes('abc123') && !JSON.stringify(json).includes('internal'))
})

test('GET, DELETE, PUT and PATCH answer 405 with Allow: POST', async () => {
  for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
    const res = await handleMcpRequest(new Request('http://x/api/mcp', { method, headers: HEADERS }), async () => dto())
    assert.equal(res.status, 405, method)
    assert.equal(res.headers.get('allow'), 'POST')
    assert.equal(res.headers.get('cache-control'), 'no-store')
  }
})

test('route: runtime nodejs, force-dynamic, reuses the Unified GET with project=driveset hard-coded, no fetch / SQL / env access', () => {
  const route = readFileSync(new URL('../app/api/mcp/route.ts', import.meta.url), 'utf8')
  assert.match(route, /export const runtime = 'nodejs'/)
  assert.match(route, /export const dynamic = 'force-dynamic'/)
  assert.match(route, /import \{ GET as unifiedGet \} from '@\/app\/api\/ads\/unified\/route'/)
  assert.match(route, /project=driveset&period=\$\{period\}/)
  assert.doesNotMatch(route, /\bfetch\(|pool|Authorization/)
  assert.deepEqual([...route.matchAll(/process\.env\.(\w+)/g)].map((m) => m[1]), ['OLNOO_MCP_KEY']) // the only env read here; Direct reads its own config
  const lib = readFileSync(new URL('./mcp-summary.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(lib, /\bfetch\(|process\.env|@\/lib/)
})
