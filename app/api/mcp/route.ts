import { GET as unifiedGet } from '@/app/api/ads/unified/route'
import { handleMcpRequest, toSummaryDto, type SummaryDto } from '@/lib/mcp-summary'
import type { UnifiedPayload } from '@/lib/unified-analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * OLNOO Agent v1 — remote MCP endpoint (Streamable HTTP, stateless, JSON). ONE read-only tool, `get_driveset_summary(period)`.
 * The data is the existing Unified Analytics (called as a function, nothing is recomputed); the answer is a small whitelist DTO
 * (lib/mcp-summary.ts) without personal data, search queries or breakdowns. No application auth: nginx opens exactly this path
 * (`location = /api/mcp`, POST only) — see OLNOO_PROJECT_MAP.md, "OLNOO Agent v1 (MCP)". Always project `driveset`.
 */
async function loadSummary(period: string): Promise<SummaryDto> {
  const res = await unifiedGet(new Request(`http://internal/api/ads/unified?project=driveset&period=${period}`))
  const body = (await res.json()) as UnifiedPayload & { error?: unknown }
  if (!body || body.error || !body.period) throw new Error('unified_failed') // an error answer (not a partial one) becomes a generic tool error
  return toSummaryDto(body)
}

export async function POST(req: Request) {
  return handleMcpRequest(req, loadSummary)
}
export const GET = POST
export const DELETE = POST
export const PUT = POST
export const PATCH = POST
