// OAuth for the MCP endpoint (ChatGPT "Mixed" auth): Auth0 is the authorization server, olnoo-admin is only the resource server.
// This module verifies an access token (signature via the issuer's JWKS, issuer, audience, expiry, scope) and builds the
// protected-resource metadata and the MCP OAuth challenge. It stores nothing and issues nothing: no users, roles or refresh tokens here.
// Pure module (no `@/` imports): runs under `node --test`.

import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

/** The only scope: read DriveSet data through the MCP (summary and Direct search queries). */
export const MCP_SCOPE = 'direct:read'

export type McpOAuthConfig = { issuer: string; audience: string }

/**
 * `OLNOO_MCP_OAUTH_ISSUER` (Auth0 tenant URL, must equal the token's `iss`, trailing slash included) and
 * `OLNOO_MCP_OAUTH_AUDIENCE` (the Auth0 API identifier = the connector URL, e.g. https://admin.olnoo.com/api/mcp).
 * Missing or malformed → null → the protected tool stays unavailable (nothing is guessed).
 */
export function parseOAuthConfig(env: Record<string, string | undefined>): McpOAuthConfig | null {
  const issuerRaw = (env.OLNOO_MCP_OAUTH_ISSUER ?? '').trim()
  const audience = (env.OLNOO_MCP_OAUTH_AUDIENCE ?? '').trim()
  try {
    const i = new URL(issuerRaw)
    const a = new URL(audience)
    if (i.protocol !== 'https:' || a.protocol !== 'https:' || i.search || i.hash || a.search || a.hash) return null
    return { issuer: issuerRaw.endsWith('/') ? issuerRaw : `${issuerRaw}/`, audience }
  } catch {
    return null
  }
}

/** Where ChatGPT finds the protected-resource metadata (the origin of the MCP resource). */
export function resourceMetadataUrl(cfg: McpOAuthConfig): string {
  return `${new URL(cfg.audience).origin}/.well-known/oauth-protected-resource`
}

/** RFC 9728 protected-resource metadata. */
export function protectedResourceMetadata(cfg: McpOAuthConfig) {
  return {
    resource: cfg.audience,
    authorization_servers: [cfg.issuer],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
  }
}

/** Value for `_meta["mcp/www_authenticate"]` — it makes ChatGPT open the account-linking flow for the tool. */
export function wwwAuthenticateChallenge(cfg: McpOAuthConfig, error: 'insufficient_scope' | 'invalid_token' = 'insufficient_scope'): string {
  const description = error === 'invalid_token' ? 'Sign in again to continue' : 'Sign in to read DriveSet data'
  return `Bearer resource_metadata="${resourceMetadataUrl(cfg)}", scope="${MCP_SCOPE}", error="${error}", error_description="${description}"`
}

export type TokenCheck = { ok: true } | { ok: false; reason: 'missing' | 'invalid' | 'insufficient_scope' }

const jwksCache = new Map<string, JWTVerifyGetKey>()
function remoteKeys(issuer: string): JWTVerifyGetKey {
  let keys = jwksCache.get(issuer)
  if (!keys) {
    keys = createRemoteJWKSet(new URL('.well-known/jwks.json', issuer)) // jose caches and rotates the keys itself
    jwksCache.set(issuer, keys)
  }
  return keys
}

/**
 * Checks `Authorization: Bearer <JWT>`: RS256 signature against the issuer's JWKS, `iss`, `aud`, `exp` (and `nbf`), and the
 * `direct:read` scope (the space-separated `scope` claim). The reason is a category only — never the token or a claim value.
 * `keys` is injectable for tests.
 */
export async function verifyAccessToken(req: Request, cfg: McpOAuthConfig, keys: JWTVerifyGetKey = remoteKeys(cfg.issuer)): Promise<TokenCheck> {
  const auth = req.headers.get('authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return { ok: false, reason: 'missing' }
  const token = auth.slice(7).trim()
  if (!token) return { ok: false, reason: 'missing' }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer: cfg.issuer, audience: cfg.audience, algorithms: ['RS256'], clockTolerance: 5 })
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : []
    return scopes.includes(MCP_SCOPE) ? { ok: true } : { ok: false, reason: 'insufficient_scope' }
  } catch {
    return { ok: false, reason: 'invalid' }
  }
}
