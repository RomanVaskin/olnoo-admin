// Pure Meta long-lived-token refresh calls, kept dependency-free (zero `@/` imports) for the same
// reason lib/social-vk-verify.ts is — directly runnable by this project's plain `node --test`.
//
// Both Instagram Login and Threads issue long-lived access tokens valid for ~60 days, each with
// its own documented refresh endpoint/grant type (confirmed against Meta's current developer docs
// before writing this, per this task's own instruction not to guess token-lifecycle rules):
//   - Instagram: GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token
//     &access_token=<long-lived token>. Eligibility: the token must be at least 24 hours old and
//     not yet expired. A successful refresh returns a new token valid for another 60 days from the
//     refresh date.
//   - Threads: GET https://graph.threads.net/v1.0/refresh_access_token?grant_type=th_refresh_token
//     &access_token=<long-lived token>. Same 24-hour-minimum-age / not-yet-expired eligibility,
//     same new-60-day-window-on-success behavior.
// Neither call accepts the app secret or a separate refresh token — the long-lived access token
// itself is both the credential being refreshed and the proof of identity, which is why this file
// only ever takes one argument.
//
// A token younger than 24h, or one that has already expired, is rejected by Meta with its own API
// error — this is surfaced as `{ ok: false, error }` like any other failure, never guessed at or
// retried differently; the caller (lib/social-accounts-instagram-connection.ts /
// lib/social-accounts-threads-connection.ts) falls back to verifying the existing token instead of
// treating a refresh failure as fatal.

const IG_API_BASE = process.env.INSTAGRAM_API_BASE_URL || 'https://graph.instagram.com'
const THREADS_API_BASE = `${process.env.THREADS_API_BASE_URL || 'https://graph.threads.net'}/v1.0`

export type MetaTokenRefreshResult = { ok: true; token: string; expiresAt: Date } | { ok: false; error: string }

async function callRefresh(url: string, platformLabel: string): Promise<MetaTokenRefreshResult> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (err) {
    return { ok: false, error: `Could not reach the ${platformLabel} API: ${err instanceof Error ? err.message : String(err)}` }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.error) {
    return { ok: false, error: (data?.error?.message as string) || `${platformLabel} token refresh failed (${res.status})` }
  }
  const token = typeof data?.access_token === 'string' ? data.access_token : ''
  const expiresInSeconds = typeof data?.expires_in === 'number' ? data.expires_in : 0
  if (!token || !expiresInSeconds) {
    return { ok: false, error: `${platformLabel} did not return a refreshed access token` }
  }
  return { ok: true, token, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) }
}

export async function refreshInstagramLongLivedToken(token: string): Promise<MetaTokenRefreshResult> {
  const params = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })
  return callRefresh(`${IG_API_BASE}/refresh_access_token?${params.toString()}`, 'Instagram')
}

export async function refreshThreadsLongLivedToken(token: string): Promise<MetaTokenRefreshResult> {
  const params = new URLSearchParams({ grant_type: 'th_refresh_token', access_token: token })
  return callRefresh(`${THREADS_API_BASE}/refresh_access_token?${params.toString()}`, 'Threads')
}
