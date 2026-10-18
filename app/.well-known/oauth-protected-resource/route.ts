import { parseOAuthConfig, protectedResourceMetadata } from '@/lib/mcp-oauth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * OAuth protected-resource metadata for the MCP endpoint (RFC 9728): tells ChatGPT which authorization server (Auth0) protects
 * `get_direct_queries` and which scope it needs. Public by design (no secrets); 404 until the OAuth env is configured.
 * nginx must open this exact path — see OLNOO_PROJECT_MAP.md, "OLNOO Agent v1 (MCP)".
 */
export async function GET() {
  const cfg = parseOAuthConfig(process.env)
  if (!cfg) return Response.json({ error: 'not configured' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
  return Response.json(protectedResourceMetadata(cfg), { headers: { 'Cache-Control': 'no-store' } })
}
