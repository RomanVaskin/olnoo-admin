// OLNOO Agent v1: one read-only MCP tool, `get_driveset_summary(period)`, on top of Unified Analytics.
// Pure module (no `@/` imports): runs under `node --test`. The Unified numbers are NOT recomputed here — the route hands
// in the existing Unified payload and this file only whitelists a small DTO and serves the MCP protocol.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { UnifiedPayload } from './unified-analytics.ts'
import { QUERIES_TOOL_DESCRIPTION, QUERIES_TOOL_NAME, type DirectQueriesDto } from './mcp-direct-queries.ts'

export const SUMMARY_PERIODS = ['today', 'yesterday', 'last7'] as const
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number]

export const SUMMARY_TOOL_NAME = 'get_driveset_summary'
export const SUMMARY_TOOL_DESCRIPTION =
  'Read-only DriveSet summary from Unified Analytics (Yandex Direct + Metrika + CRM): Direct impressions/clicks/spend/CPC/CTR, Metrika visits, ' +
  'CRM leads split into REAL / TEST / UNKNOWN, REAL Direct leads, CPL and warnings. Moscow calendar days. A null value means "not available" (see status and warnings), never zero.'
/** The only input. There is deliberately no project parameter: the tool always reads DriveSet. */
export const SUMMARY_INPUT_SHAPE = { period: z.enum(SUMMARY_PERIODS).default('today').describe('today (partial, CPL not calculated), yesterday or last7 (the 7 complete days before today)') }

// ---- DTO (whitelist: every field is copied by name, nothing else can leak) --------------------------------------

export type SummaryDto = {
  period: { from: string; to: string; complete: boolean; preset: string }
  direct: { status: string; impressions: number | null; clicks: number | null; spend: number | null; cpc: number | null; ctr: number | null }
  metrika: { status: string; visits: number | null }
  crm: { status: string; leadsTotal: number | null; leadsReal: number | null; leadsTest: number | null; leadsUnknown: number | null; leadsDirectReal: number | null }
  conversions: { cpl: { value: number | null; reason?: string } }
  warnings: { code: string; message: string; source?: string }[]
  generatedAt: string
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown, fallback = 'unavailable'): string => (typeof v === 'string' ? v : fallback)

/** Unified payload → summary DTO. Missing or non-numeric values stay null (never coerced to 0). */
export function toSummaryDto(payload: Pick<UnifiedPayload, 'period' | 'direct' | 'metrika' | 'crm' | 'conversions' | 'warnings' | 'meta'>): SummaryDto {
  const cpl = payload.conversions.cpl as { value?: unknown; reason?: unknown }
  const cplReason = typeof cpl.reason === 'string' ? cpl.reason : undefined
  return {
    period: { from: payload.period.from, to: payload.period.to, complete: payload.period.complete === true, preset: payload.period.preset },
    direct: {
      status: str(payload.direct.status),
      impressions: num(payload.direct.impressions),
      clicks: num(payload.direct.clicks),
      spend: num(payload.direct.spend),
      cpc: num(payload.direct.cpc),
      ctr: num(payload.direct.ctr),
    },
    metrika: { status: str(payload.metrika.status), visits: num(payload.metrika.visits) },
    crm: {
      status: str(payload.crm.status),
      leadsTotal: num(payload.crm.leadsTotal),
      leadsReal: num(payload.crm.leadsReal),
      leadsTest: num(payload.crm.leadsTest),
      leadsUnknown: num(payload.crm.leadsUnknown),
      leadsDirectReal: num(payload.crm.leadsDirectReal),
    },
    conversions: { cpl: { value: num(cpl.value), ...(cplReason ? { reason: cplReason } : {}) } },
    warnings: payload.warnings.map((w) => {
      const source = (w as { source?: unknown }).source
      return { code: str(w.code, ''), message: str(w.message, ''), ...(typeof source === 'string' ? { source } : {}) }
    }),
    generatedAt: str(payload.meta.generatedAt, ''),
  }
}

// ---- MCP over Streamable HTTP (official SDK, stateless, JSON responses) ---------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' }

export type QueriesLoader = (period: SummaryPeriod) => Promise<DirectQueriesDto>

function createServer(getSummary: (period: SummaryPeriod) => Promise<SummaryDto>, getQueries?: QueriesLoader): McpServer {
  const server = new McpServer({ name: 'olnoo', version: '1.0.0' })
  server.registerTool(
    SUMMARY_TOOL_NAME,
    { description: SUMMARY_TOOL_DESCRIPTION, inputSchema: SUMMARY_INPUT_SHAPE, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    async ({ period }) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await getSummary(period)) }] }
      } catch {
        // Kind only: no upstream message, token, URL or row ever reaches the client.
        return { isError: true, content: [{ type: 'text' as const, text: 'DriveSet summary is temporarily unavailable.' }] }
      }
    },
  )
  // Registered ONLY for a request that carries the server key (see hasMcpKey); otherwise the tool does not exist for that caller.
  if (getQueries) {
    server.registerTool(
      QUERIES_TOOL_NAME,
      { description: QUERIES_TOOL_DESCRIPTION, inputSchema: SUMMARY_INPUT_SHAPE, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
      async ({ period }) => {
        try {
          return { content: [{ type: 'text' as const, text: JSON.stringify(await getQueries(period)) }] }
        } catch {
          return { isError: true, content: [{ type: 'text' as const, text: 'Direct search queries are temporarily unavailable.' }] }
        }
      },
    )
  }
  return server
}

/** POST only (405 for everything else). A fresh server + transport per request: nothing is shared between calls. */
/** `getQueries` is passed by the caller only when the request is authorised for the (non-public) search-query tool. */
export async function handleMcpRequest(req: Request, getSummary: (period: SummaryPeriod) => Promise<SummaryDto>, getQueries?: QueriesLoader): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { ...JSON_HEADERS, Allow: 'POST' } })
  }
  const server = createServer(getSummary, getQueries)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  const res = await transport.handleRequest(req)
  const headers = new Headers(res.headers)
  for (const [k, v] of Object.entries(JSON_HEADERS)) headers.set(k, v)
  return new Response(res.body, { status: res.status, headers })
}
