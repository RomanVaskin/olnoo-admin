import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// No `@/` imports — directly testable under `node --test`. Server-side only.
//
// Requirement 8 ("store the refresh token in protected server configuration for now, no token
// table"): the one artifact the OAuth callback ever produces is written ONCE to a local file on
// this server's own disk — never to Postgres, never to Git (the default path lives under
// `secrets/`, listed in .gitignore the same way `/uploads/` already is), never echoed back in the
// HTTP response. This is a deliberate, minimal bootstrap mechanism, not a long-term secret store:
// the admin is expected to open this file directly on the server's filesystem (a channel outside
// this application's own browser/log/API surface — see lib/google-ads-oauth.ts's own comment on
// why that distinction matters for requirement 7), copy the value into
// `GOOGLE_ADS_OAUTH_REFRESH_TOKEN` in the real env file (`.env.local` / the deploy-managed
// `.env.production.local`, same convention every other secret in this app already uses), restart
// the app, and then delete this file. Nothing in this app reads this file back — a future
// Observer would read the promoted env var, not this bootstrap file.

export function resolveTokenFilePath(): string {
  return process.env.GOOGLE_ADS_OAUTH_TOKEN_FILE?.trim() || 'secrets/google-ads-refresh-token.json'
}

export type SaveTokenResult = { ok: true; path: string } | { ok: false; error: string }

/** Writes `{ refreshToken, scope, obtainedAt }` to `filePath` as JSON, creating its parent
 * directory if needed, with owner-only file permissions (0600) — never throws; a filesystem error
 * is returned, not thrown, so the callback route can still answer with a clear error instead of a
 * generic 500. The refresh token itself is never included in the returned result, only `path`. */
export async function saveRefreshTokenToLocalFile(
  refreshToken: string,
  scope: string,
  filePath: string = resolveTokenFilePath(),
): Promise<SaveTokenResult> {
  try {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
    const payload = JSON.stringify({ refreshToken, scope, obtainedAt: new Date().toISOString() }, null, 2)
    await writeFile(filePath, payload, { mode: 0o600 })
    return { ok: true, path: filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
