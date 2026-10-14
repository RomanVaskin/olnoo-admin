import { NextResponse } from 'next/server'
import {
  resolveGoogleAdsOAuthConfig,
  verifyOAuthState,
  classifyCallbackParams,
  exchangeCodeForTokens,
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

function htmlResponse(status: number, title: string, bodyHtml: string): NextResponse {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family: sans-serif; max-width: 640px; margin: 40px auto; line-height: 1.5;"><h1>${title}</h1>${bodyHtml}</body></html>`
  return new NextResponse(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

const RETRY_LINK_HTML = '<p><a href="/api/ads/google-ads/oauth/start">Start the authorization flow again</a>.</p>'

export async function GET(req: Request) {
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
      `<p>Google reported: <code>${decision.error}</code>${decision.errorDescription ? ` — ${decision.errorDescription}` : ''}</p>${RETRY_LINK_HTML}`,
    )
  }
  if (decision.kind === 'invalid') {
    return htmlResponse(400, 'Invalid callback request', `<p>${decision.reason}.</p>${RETRY_LINK_HTML}`)
  }

  // decision.kind === 'success' — verify `state` before touching the authorization code at all
  // (requirement 4: CSRF protection). A failed check here means this request did not originate
  // from a state value THIS server minted (forged/replayed) — the code is never exchanged.
  const stateCheck = verifyOAuthState(config.clientSecret, decision.state)
  if (!stateCheck.ok) {
    console.warn('[google-ads-oauth] state verification failed:', stateCheck.error)
    return htmlResponse(400, 'Could not verify this request', `<p>${stateCheck.error}.</p>${RETRY_LINK_HTML}`)
  }

  const exchanged = await exchangeCodeForTokens(config, decision.code)
  if (!exchanged.ok) {
    console.error('[google-ads-oauth] token exchange failed:', exchanged.error)
    return htmlResponse(502, 'Could not complete authorization with Google', `<p>${exchanged.error}.</p>${RETRY_LINK_HTML}`)
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
      `<p>Google granted access, but writing the result to the server's local file failed: <code>${saved.error}</code>. Nothing was stored. Retry, or check the server's filesystem permissions.</p>${RETRY_LINK_HTML}`,
    )
  }

  return htmlResponse(
    200,
    'Google Ads authorization complete',
    `<p>A refresh token was obtained and saved to a local file on the server at <code>${saved.path}</code> — it is not shown here.</p>
     <p><strong>Next steps (manual):</strong></p>
     <ol>
       <li>On the server, open that file and copy the <code>refreshToken</code> value.</li>
       <li>Set it as <code>GOOGLE_ADS_OAUTH_REFRESH_TOKEN</code> in the real server env file, then restart the app.</li>
       <li>Delete <code>${saved.path}</code> — it is a one-time handoff file, not a secret store.</li>
     </ol>`,
  )
}
