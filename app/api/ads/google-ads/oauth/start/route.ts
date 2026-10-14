import { NextRequest, NextResponse } from 'next/server'
import {
  resolveGoogleAdsOAuthConfig,
  createOAuthState,
  buildGoogleAdsAuthorizationUrl,
  OAUTH_STATE_COOKIE_NAME,
  oauthStateCookieOptions,
  isHttpsRequest,
} from '@/lib/google-ads-oauth'

export const runtime = 'nodejs'

// Admin-initiated only — not a public/technical endpoint. Deliberately left under nginx's default
// `location /` in production (auth_basic-protected), same as every other Admin screen/API; it is
// NOT added to the exact-`location =` exemption list other technical endpoints (/api/leads/inbound,
// /api/telegram/*-webhook, /api/mcp) use — see OLNOO_PROJECT_MAP.md's "Google Ads OAuth MVP" for
// why that existing external layer is this route's only access control, and why that's enough:
// this app has no login/session of its own for ANY admin screen, and this route is no different
// from, say, the Ads campaigns list in that respect.
//
// GET only, meant to be opened directly by an admin's browser (a real page navigation, not a
// fetch() call) — it responds with a 302 redirect straight to Google's consent screen, and sets
// the short-lived state-binding cookie the callback checks (see lib/google-ads-oauth.ts's comment
// on `verifyStateCookieBinding` for what this does and does not protect against).
export async function GET(req: NextRequest) {
  const config = resolveGoogleAdsOAuthConfig()
  if (!config) {
    return NextResponse.json(
      {
        error:
          'Google Ads OAuth is not configured on the server — set GOOGLE_ADS_OAUTH_CLIENT_ID, GOOGLE_ADS_OAUTH_CLIENT_SECRET and GOOGLE_ADS_OAUTH_REDIRECT_URI, then retry this link.',
      },
      { status: 503 },
    )
  }
  const state = createOAuthState(config.clientSecret)
  const authorizationUrl = buildGoogleAdsAuthorizationUrl(config, state)
  const response = NextResponse.redirect(authorizationUrl)
  const secure = isHttpsRequest(req.url, req.headers.get('x-forwarded-proto'))
  response.cookies.set(OAUTH_STATE_COOKIE_NAME, state, oauthStateCookieOptions(secure))
  return response
}
