// Pure VK groups.getById call + response parsing, split out of lib/social-accounts-vk-connection.ts
// so it has zero `@/`-aliased imports and is directly runnable by this project's plain `node --test`
// (same reason lib/social-threads-text.ts is kept dependency-free, unlike lib/social-threads.ts
// itself — see that file's own comment).

// Not a secret — same override role as VK_API_BASE_URL elsewhere, only for pointing a
// non-production environment at a mock VK API. lib/social-vk.ts reads the identical env var for
// its own, separately-exported VK_API_BASE; kept as two reads (not one shared import) specifically
// to avoid an `@/` import here.
const VK_API_BASE = process.env.VK_API_BASE_URL || 'https://api.vk.com'
const VK_API_VERSION = '5.199'

export type VkGroupIdentity = { groupId: string; screenName: string; name: string }
export type VkVerifyResult = { ok: true; identity: VkGroupIdentity } | { ok: false; error: string }

/**
 * Verifies a VK token is a community/group token (not a user token) by calling the official
 * groups.getById method with no group_id — VK's documented behavior for a group access token is to
 * return that one group's own identity, which is exactly the "does this token work, and which
 * community does it actually belong to" check requirement 5 asks for. A user access token, or an
 * invalid/revoked one, comes back as a VK API error here instead.
 */
export async function verifyVkGroupToken(token: string): Promise<VkVerifyResult> {
  const params = new URLSearchParams({ access_token: token, v: VK_API_VERSION })
  let res: Response
  try {
    res = await fetch(`${VK_API_BASE}/method/groups.getById?${params.toString()}`)
  } catch (err) {
    return { ok: false, error: `Could not reach VK API: ${err instanceof Error ? err.message : String(err)}` }
  }
  const data = await res.json().catch(() => null)
  if (!res.ok || data?.error) {
    return { ok: false, error: (data?.error?.error_msg as string) || `VK API request failed (${res.status})` }
  }
  // VK's documented response shape for this method has varied across API versions (a plain array,
  // or `{ count, items }`, or `{ groups }` in some SDKs' own wrappers) — accept whichever of these
  // the live API actually returns rather than assuming one.
  const response = data?.response
  const group = Array.isArray(response)
    ? response[0]
    : Array.isArray(response?.items)
      ? response.items[0]
      : Array.isArray(response?.groups)
        ? response.groups[0]
        : null
  if (!group || typeof group.id !== 'number') {
    return {
      ok: false,
      error: 'VK did not return a community for this token — make sure it is a community/group access token, not a user token',
    }
  }
  return {
    ok: true,
    identity: {
      groupId: String(group.id),
      screenName: typeof group.screen_name === 'string' ? group.screen_name : '',
      name: typeof group.name === 'string' ? group.name : '',
    },
  }
}
