// Pure Threads API `/me` call + response parsing, split out of
// lib/social-accounts-threads-connection.ts so it has zero `@/`-aliased imports and is directly
// runnable by this project's plain `node --test` (same reason lib/social-vk-verify.ts is kept
// dependency-free).

const THREADS_API_BASE = `${process.env.THREADS_API_BASE_URL || 'https://graph.threads.net'}/v1.0`

export type ThreadsAccountIdentity = { userId: string; username: string }
export type ThreadsVerifyResult = { ok: true; identity: ThreadsAccountIdentity } | { ok: false; error: string }

/**
 * Verifies a Threads access token actually works, and discovers the user it belongs to, by
 * calling the documented `/me` endpoint with `fields=id,username` — same role as
 * verifyInstagramAccountToken's `/me` call: both the "does this token work" check and the user-id
 * lookup in one request.
 *
 * Unlike Instagram, the Threads API has no `account_type` field to reject a non-publishing-capable
 * account by — a Threads user only gets API access at all once the Meta app has been granted
 * `threads_basic`/`threads_content_publish` for that user, so a successful `/me` call is already
 * the strongest signal available here. There is no side-effect-free way to confirm the
 * `threads_content_publish` permission specifically (unlike VK's groups.getById, which can't be
 * faked by a lesser-scoped token) short of attempting a real post — that gap is documented, not
 * papered over, in lib/social-accounts-threads-connection.ts.
 */
export async function verifyThreadsAccountToken(token: string): Promise<ThreadsVerifyResult> {
  const params = new URLSearchParams({ fields: 'id,username', access_token: token })
  let res: Response
  try {
    res = await fetch(`${THREADS_API_BASE}/me?${params.toString()}`)
  } catch (err) {
    return { ok: false, error: `Could not reach the Threads API: ${err instanceof Error ? err.message : String(err)}` }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.error) {
    return { ok: false, error: (data?.error?.message as string) || `Threads API request failed (${res.status})` }
  }
  const userId = typeof data?.id === 'string' ? data.id : typeof data?.id === 'number' ? String(data.id) : ''
  const username = typeof data?.username === 'string' ? data.username : ''
  if (!userId) {
    return { ok: false, error: 'Threads did not return a user id for this token' }
  }
  return { ok: true, identity: { userId, username } }
}
