import { GET as unifiedGet } from '@/app/api/ads/unified/route'
import { toQueriesDto, type DirectQueriesDto } from '@/lib/mcp-direct-queries'
import { MCP_QUERIES_SCOPE, parseOAuthConfig, verifyAccessToken, wwwAuthenticateChallenge } from '@/lib/mcp-oauth'
import { handleMcpRequest, toSummaryDto, type SummaryDto, type SummaryPeriod } from '@/lib/mcp-summary'
import { resolveObserverPeriod } from '@/lib/observer-period'
import { UNIFIED_PROJECTS, type UnifiedPayload } from '@/lib/unified-analytics'
import { createDirectClient, directConfigFromEnv, DirectApiError, resolveCampaignId } from '@/lib/yandex-direct'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * OLNOO Agent v1 — remote MCP endpoint (Streamable HTTP, stateless, JSON), always project `driveset`, read-only. ChatGPT "Mixed" auth:
 *  - `get_driveset_summary(period)`: the existing Unified Analytics as a whitelist DTO — `noauth` (public, no search queries).
 *  - `get_direct_queries(period)` (Direct MCP Eyes v1): top search queries + current negative keywords from the existing Direct
 *    client — `oauth2`, scope `direct:read`. Auth0 is the authorization server; this route only verifies the access token
 *    (lib/mcp-oauth.ts) and answers a missing/invalid one with the MCP OAuth challenge. No keys in the URL, no static secrets.
 * nginx opens exactly this path (`location = /api/mcp`, POST only) and `/.well-known/oauth-protected-resource` — see OLNOO_PROJECT_MAP.md.
 */
async function loadSummary(period: string): Promise<SummaryDto> {
  const res = await unifiedGet(new Request(`http://internal/api/ads/unified?project=driveset&period=${period}`))
  const body = (await res.json()) as UnifiedPayload & { error?: unknown }
  if (!body || body.error || !body.period) throw new Error('unified_failed') // an error answer (not a partial one) becomes a generic tool error
  return toSummaryDto(body)
}

async function loadQueries(period: SummaryPeriod): Promise<DirectQueriesDto> {
  const cfg = directConfigFromEnv()
  if (!cfg) throw new DirectApiError('not_configured', 'Yandex Direct is not configured')
  const resolved = resolveObserverPeriod(new URLSearchParams({ period }))
  if ('error' in resolved) throw new Error('bad_period')
  const campaignId = resolveCampaignId(String(UNIFIED_PROJECTS.driveset.campaignId), cfg.campaignIds)
  const payload = await createDirectClient(cfg).observePeriod(campaignId, { from: resolved.from, to: resolved.to }, { structure: true })
  return toQueriesDto(payload, { complete: resolved.complete, preset: resolved.preset }, new Date())
}

export async function POST(req: Request) {
  const oauth = parseOAuthConfig(process.env)
  let failure: 'missing' | 'invalid' | 'insufficient_scope' = 'missing'
  return handleMcpRequest(req, loadSummary, {
    load: loadQueries,
    scope: MCP_QUERIES_SCOPE,
    authorize: async () => {
      if (!oauth) return 'unconfigured'
      const check = await verifyAccessToken(req, oauth)
      if (check.ok) return 'ok'
      failure = check.reason
      return 'denied'
    },
    challenge: oauth ? () => wwwAuthenticateChallenge(oauth, failure === 'invalid' ? 'invalid_token' : 'insufficient_scope') : null,
  })
}
export const GET = POST
export const DELETE = POST
export const PUT = POST
export const PATCH = POST
