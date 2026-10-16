import { NextRequest, NextResponse } from 'next/server'
import {
  resolveGoogleAdsOAuthConfig,
  verifyOAuthState,
  verifyStateCookieBinding,
  classifyCallbackParams,
  exchangeCodeForTokens,
  escapeHtml,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_COOKIE_PATH,
} from '@/lib/google-ads-oauth'
import { saveRefreshTokenToLocalFile } from '@/lib/google-ads-oauth-token-store'

export const runtime = 'nodejs'

// Same access posture as .../oauth/start/route.ts — left under nginx's default auth_basic
// protection, not exempted. GET only (this is exactly where Google redirects the admin's browser
// back to after the consent screen; it never accepts a POST).
//
// Requirement 7 ("never expose the access/refresh token or client secret to the browser, logs, or
// API responses"): every response below is a plain, generic HTML page — never the token value,
// never config.clientSecret, never the raw Google token-endpoint response. The one place the
// refresh token value itself ever goes is the local file lib/google-ads-oauth-token-store.ts
// writes — a channel outside this route's own browser-facing response.
//
// Every value below that could originate outside this server (Google's `error`/
// `error_description` query params, our own classification/verification error strings that may
// echo part of the request, the token-exchange error) is passed through `escapeHtml` before being
// interpolated into the HTML — none of it is attacker-controlled HTML/script by construction
// today, but this route must stay safe even if that changes upstream.

function htmlResponse(status: number, title: string, bodyHtml: string): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.5;"><h1>${escapeHtml(title)}</h1>${bodyHtml}</body></html>`
  const response = new NextResponse(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  // The state-binding cookie is single-use by intent: every response path below clears it, success
  // or failure, so a leftover cookie can never be reused across two separate attempts.
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, '', { path: OAUTH_STATE_COOKIE_PATH, maxAge: 0 })
  return response
}

const RETRY_LINK_HTML = '<p><a href="/api/ads/google-ads/oauth/start">Start the authorization flow again</a>.</p>'

export async function GET(req: NextRequest) {
  const config = resolveGoogleAdsOAuthConfig()
  if (!config) {
    return htmlResponse(
      503,
      'Google Ads OAuth is not configured',
      '<p>Set GOOGLE_ADS_OAUTH_CLIENT_ID, GOOGLE_ADS_OAUTH_CLIENT_SECRET and GOOGLE_ADS_OAUTH_REDIRECT_URI on the server, then retry.</p>',
    )
  }

  const { searchParams } = new URL(req.url)
  const decision = classifyCallbackParams(searchParams)

  if (decision.kind === 'denied') {
    // The test user declined on Google's consent screen, or Google itself refused (e.g. an
    // org/admin policy) — a normal, expected outcome, not a server error.
    console.warn('[google-ads-oauth] authorization denied:', decision.error)
    return htmlResponse(
      200,
      'Authorization was not completed',
      `<p>Google reported: <code>${escapeHtml(decision.error)}</code>${decision.errorDescription ? ` — ${escapeHtml(decision.errorDescription)}` : ''}</p>${RETRY_LINK_HTML}`,
    )
  }
  if (decision.kind === 'invalid') {
    return htmlResponse(400, 'Invalid callback request', `<p>${escapeHtml(decision.reason)}.</p>${RETRY_LINK_HTML}`)
  }

  // decision.kind === 'success' — two independent checks before the authorization code is ever
  // touched (requirement 4: CSRF protection): the state's own HMAC signature and max-age, AND that
  // this browser is the one /start set the cookie for. See lib/google-ads-oauth.ts's comment above
  // `verifyOAuthState`/`verifyStateCookieBinding` for exactly what each does and does not prove —
  // together they are time-bounded CSRF protection, not single-use/replay protection.
  const stateCheck = verifyOAuthState(config.clientSecret, decision.state)
  if (!stateCheck.ok) {
    console.warn('[google-ads-oauth] state verification failed:', stateCheck.error)
    return htmlResponse(400, 'Could not verify this request', `<p>${escapeHtml(stateCheck.error)}.</p>${RETRY_LINK_HTML}`)
  }
  const cookieCheck = verifyStateCookieBinding(req.cookies.get(OAUTH_STATE_COOKIE_NAME)?.value, decision.state)
  if (!cookieCheck.ok) {
    console.warn('[google-ads-oauth] state cookie binding failed:', cookieCheck.error)
    return htmlResponse(400, 'Could not verify this request', `<p>${escapeHtml(cookieCheck.error)}.</p>${RETRY_LINK_HTML}`)
  }

  const exchanged = await exchangeCodeForTokens(config, decision.code)
  if (!exchanged.ok) {
    console.error('[google-ads-oauth] token exchange failed:', exchanged.error)
    return htmlResponse(502, 'Could not complete authorization with Google', `<p>${escapeHtml(exchanged.error)}.</p>${RETRY_LINK_HTML}`)
  }

  const saved = await saveRefreshTokenToLocalFile(exchanged.refreshToken, exchanged.scope)
  if (!saved.ok) {
    // The token was successfully obtained from Google but could not be persisted anywhere this
    // app controls — surfacing this as a clear failure (never the token value itself) is safer
    // than silently discarding it with an apparent "success".
    console.error('[google-ads-oauth] could not save the refresh token to disk:', saved.error)
    return htmlResponse(
      500,
      'Authorization succeeded, but the token could not be saved',
      `<p>Google granted access, but writing the result to the server's local file failed: <code>${escapeHtml(saved.error)}</code>. Nothing was stored. Retry, or check the server's filesystem permissions.</p>${RETRY_LINK_HTML}`,
    )
  }

  return htmlResponse(
    200,
    'Google Ads authorization complete',
    `<p>A refresh token was obtained and saved to a local file on the server at <code>${escapeHtml(saved.path)}</code> — it is not shown here.</p>
     <p><strong>Next steps (manual):</strong></p>
     <ol>
       <li>On the server, open that file and copy the <code>refreshToken</code> value.</li>
       <li>Set it as <code>GOOGLE_ADS_OAUTH_REFRESH_TOKEN</code> in the real server env file, then restart the app.</li>
       <li>Delete <code>${escapeHtml(saved.path)}</code> — it is a one-time handoff file, not a secret store.</li>
     </ol>`,
  )
}
