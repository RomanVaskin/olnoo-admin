// Pure Instagram Login API `/me` call + response parsing, split out of
// lib/social-accounts-instagram-connection.ts so it has zero `@/`-aliased imports and is directly
// runnable by this project's plain `node --test` (same reason lib/social-vk-verify.ts is kept
// dependency-free).

const IG_API_BASE = process.env.INSTAGRAM_API_BASE_URL || 'https://graph.instagram.com'

export type InstagramAccountIdentity = { accountId: string; username: string; accountType: string }
export type InstagramVerifyResult = { ok: true; identity: InstagramAccountIdentity } | { ok: false; error: string }

/**
 * Verifies an Instagram Login access token actually works, and discovers the account it belongs
 * to, by calling the documented `/me` endpoint with `fields=user_id,username,account_type` — this
 * is the one call that is scoped to "whichever account this specific token is for", so it doubles
 * as both the "does this token work" check and the account-id lookup (no need for the admin to
 * paste a numeric id by hand).
 *
 * A token for a PERSONAL (non-professional) Instagram account comes back from `/me` just fine but
 * can never actually call media_publish — Meta's content-publishing endpoints require a Business
 * or Creator account. Rejecting that here means a bad connection attempt fails immediately with an
 * actionable message, instead of only failing much later at actual publish time.
 */
export async function verifyInstagramAccountToken(token: string): Promise<InstagramVerifyResult> {
  const params = new URLSearchParams({ fields: 'user_id,username,account_type', access_token: token })
  let res: Response
  try {
    res = await fetch(`${IG_API_BASE}/me?${params.toString()}`)
  } catch (err) {
    return { ok: false, error: `Could not reach the Instagram API: ${err instanceof Error ? err.message : String(err)}` }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.error) {
    return { ok: false, error: (data?.error?.message as string) || `Instagram API request failed (${res.status})` }
  }
  const accountId = typeof data?.user_id === 'string' ? data.user_id : typeof data?.user_id === 'number' ? String(data.user_id) : ''
  const username = typeof data?.username === 'string' ? data.username : ''
  const accountType = typeof data?.account_type === 'string' ? data.account_type : ''
  if (!accountId) {
    return { ok: false, error: 'Instagram did not return an account id for this token' }
  }
  if (accountType === 'PERSONAL') {
    return {
      ok: false,
      error:
        'This Instagram token belongs to a personal account. Content publishing requires a Business or Creator account ' +
        '(switch the account type in the Instagram app, then reconnect).',
    }
  }
  return { ok: true, identity: { accountId, username, accountType } }
}
