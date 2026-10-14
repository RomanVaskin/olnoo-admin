import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Google Ads OAuth MVP — no `@/` imports, directly testable under this project's plain
// `node --test` (same convention as lib/social-telegram-verify.ts / lib/telegram-business.ts).
// Server-side only. This file never logs, returns, or otherwise exposes an access token, refresh
// token, or client secret — every function here either takes a secret as an opaque input or
// returns a plain `{ ok: true | false, error? }` shape with a short, generic message.
//
// Scope deliberately minimal (per the task): Authorization Code flow only, no token refresh/use,
// no Google Ads API call of any kind, no new DB table. The one artifact this flow produces (a
// refresh token) is written to a local, gitignored file by the callback route
// (app/api/ads/google-ads/oauth/callback/route.ts) — never displayed in the browser, never logged,
// never included in any API response. See OLNOO_PROJECT_MAP.md's "Google Ads OAuth MVP" for the
// full manual-step handoff this implies.

const GOOGLE_OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_OAUTH_TOKEN_URL = process.env.GOOGLE_OAUTH_TOKEN_URL || 'https://oauth2.googleapis.com/token'
const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords'

export type GoogleAdsOAuthConfig = { clientId: string; clientSecret: string; redirectUri: string }

/** Reads the three server-only env vars this flow needs (requirement 9) — fails closed (returns
 * `null`) rather than guessing or defaulting any of them, since a wrong `redirect_uri` or a
 * missing secret must never silently proceed partway into a real OAuth exchange. */
export function resolveGoogleAdsOAuthConfig(): GoogleAdsOAuthConfig | null {
  const clientId = process.env.GOOGLE_ADS_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET?.trim()
  const redirectUri = process.env.GOOGLE_ADS_OAUTH_REDIRECT_URI?.trim()
  if (!clientId || !clientSecret || !redirectUri) return null
  return { clientId, clientSecret, redirectUri }
}

// --- CSRF state: stateless, HMAC-signed, no session/DB needed -------------------------------
//
// Requirement 4 (state + CSRF protection) without a new table or in-memory session store (which
// wouldn't even survive this app's own server restarts, let alone work across multiple
// instances): the state value is a nonce + timestamp, signed with an HMAC keyed by the OAuth
// client secret the server already holds. The callback re-derives the same HMAC and compares in
// constant time; a mismatched signature (tampered/forged) or a stale timestamp (replayed from an
// old, possibly-leaked authorization URL) is rejected. The client secret is used only as HMAC key
// material here — its bytes never appear in the state value itself, and this derived use doesn't
// weaken the secret for its own, actual purpose (the token exchange call).

const STATE_MAX_AGE_MS = 10 * 60 * 1000 // 10 minutes — long enough for a human to complete Google's consent screen, short enough to make a leaked/old authorize URL useless quickly.

function signState(clientSecret: string, nonce: string, timestamp: string): string {
  return createHmac('sha256', clientSecret).update(`${nonce}.${timestamp}`).digest('hex')
}

export function createOAuthState(clientSecret: string, now: number = Date.now()): string {
  const nonce = randomBytes(16).toString('hex')
  const timestamp = String(now)
  const signature = signState(clientSecret, nonce, timestamp)
  return `${nonce}.${timestamp}.${signature}`
}

export type StateVerifyResult = { ok: true } | { ok: false; error: string }

export function verifyOAuthState(clientSecret: string, state: string | null, now: number = Date.now()): StateVerifyResult {
  if (!state) return { ok: false, error: 'missing state parameter' }
  const parts = state.split('.')
  if (parts.length !== 3) return { ok: false, error: 'malformed state parameter' }
  const [nonce, timestamp, signature] = parts
  const timestampMs = Number(timestamp)
  if (!nonce || !Number.isFinite(timestampMs)) return { ok: false, error: 'malformed state parameter' }

  const expected = signState(clientSecret, nonce, timestamp)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, error: 'state signature does not match — possible CSRF or a corrupted link' }
  }
  if (now - timestampMs > STATE_MAX_AGE_MS || now < timestampMs) {
    return { ok: false, error: 'state has expired — please start the authorization flow again' }
  }
  return { ok: true }
}

// --- Authorization URL ------------------------------------------------------------------------

export function buildGoogleAdsAuthorizationUrl(config: GoogleAdsOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: GOOGLE_ADS_SCOPE,
    access_type: 'offline', // required for Google to ever issue a refresh token
    prompt: 'consent', // forces the consent screen (and therefore a fresh refresh token) every time, even for a test user who already granted access once — otherwise a repeat run can silently come back with no refresh_token at all
    state,
  })
  return `${GOOGLE_OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

// --- Callback query-param classification -------------------------------------------------------

export type CallbackDecision =
  | { kind: 'success'; code: string; state: string }
  | { kind: 'denied'; error: string; errorDescription: string }
  | { kind: 'invalid'; reason: string }

/** Classifies the callback's own query string — never the response of the token exchange, which
 * `exchangeCodeForTokens` below handles separately. Google sends either `code`+`state` (the user
 * approved) or `error` (+ optionally `error_description`, e.g. `access_denied` if the test user
 * declined, or `admin_policy_enforced`) — never both. */
export function classifyCallbackParams(searchParams: URLSearchParams): CallbackDecision {
  const error = searchParams.get('error')
  if (error) {
    return { kind: 'denied', error, errorDescription: searchParams.get('error_description') || '' }
  }
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  if (!code) return { kind: 'invalid', reason: 'missing authorization code' }
  if (!state) return { kind: 'invalid', reason: 'missing state parameter' }
  return { kind: 'success', code, state }
}

// --- Token exchange ------------------------------------------------------------------------

export type TokenExchangeResult =
  | { ok: true; refreshToken: string; scope: string; expiresInSeconds: number }
  | { ok: false; error: string }

/**
 * Exchanges an authorization `code` for tokens via Google's OAuth token endpoint. Returns only
 * the refresh token and non-secret metadata — the access token itself is discarded immediately
 * (this MVP never calls the Google Ads API, so there is nothing to use it for, and keeping it
 * around would be one more secret to protect for no benefit). Never throws, and never includes
 * `config.clientSecret` or the authorization `code` in its returned `error` string — Google's own
 * error responses are a plain `error`/`error_description` pair that don't echo the request's
 * secret back, but this still only ever surfaces that pair, never the raw response body.
 */
export async function exchangeCodeForTokens(config: GoogleAdsOAuthConfig, code: string): Promise<TokenExchangeResult> {
  let res: Response
  try {
    res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
      }).toString(),
    })
  } catch (err) {
    return { ok: false, error: `Could not reach Google's OAuth token endpoint: ${err instanceof Error ? err.message : String(err)}` }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.error) {
    const description = typeof data?.error_description === 'string' ? data.error_description : ''
    const errorCode = typeof data?.error === 'string' ? data.error : `HTTP ${res.status}`
    return { ok: false, error: description ? `${errorCode}: ${description}` : errorCode }
  }
  const refreshToken = typeof data?.refresh_token === 'string' ? data.refresh_token : ''
  if (!refreshToken) {
    // The most common real-world cause: this test user already completed this flow once before
    // and Google is no longer including a refresh token on repeat consent — `prompt=consent`
    // above is specifically meant to prevent this, but a stale authorization code replayed from
    // an old link could still hit it.
    return { ok: false, error: 'Google did not return a refresh token — try the authorization flow again from the start link' }
  }
  return {
    ok: true,
    refreshToken,
    scope: typeof data?.scope === 'string' ? data.scope : '',
    expiresInSeconds: typeof data?.expires_in === 'number' ? data.expires_in : 0,
  }
}
