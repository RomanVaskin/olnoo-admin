// Guards Instagram/Threads publishing against posting one project's content into another
// project's real account.
//
// Why this exists: INSTAGRAM_ACCESS_TOKEN/INSTAGRAM_ACCOUNT_ID and THREADS_ACCESS_TOKEN/
// THREADS_USER_ID are global server env vars — the same ones for every project, since an
// Instagram/Threads Login token is scoped to exactly one external account. A project having an
// active, project-scoped `social_accounts` row for 'instagram'/'threads' only proves that
// project *believes* it is connected — it does not prove the global credentials actually point
// at *that* project's account. If two projects each created such a row, both would pass that
// guard and both would publish through the same global token, into whichever single account that
// token actually owns.
//
// Two checks, in order, and neither is skippable:
//
// 1. `verifyProjectIsAllowed` — the actual authorization. The global credentials for a platform
//    belong to exactly one project, named by that platform's own env var
//    (INSTAGRAM_OWNER_PROJECT / THREADS_OWNER_PROJECT) — the existing `project_id`/slug
//    mechanism every other project-scoped check in this app already uses, just pinned to one
//    fixed value per platform instead of taken from the request. Unset, or a project slug that
//    doesn't match, blocks publishing. This is the actual fix for the gap `username` alone left
//    open: `social_accounts.username` is user-editable and not unique, so two projects could
//    (accidentally or not) both set it to the same handle and both pass a username-only check —
//    the owner-project pin is the one thing in this app that can't silently collide that way,
//    because only one project can ever match a single fixed slug.
// 2. `compareAccountOwnership` — a second, independent sanity check once (1) has already
//    confirmed this is the one allowed project: does the account's own `social_accounts.username`
//    (already documented as "the real @handle, never a token or numeric id") also match the
//    actual handle the global credentials are connected to? This catches a misconfigured/blank
//    username on the *correct* project; it is deliberately never treated as sufficient on its
//    own (see (1)) specifically because it can't rule out two projects sharing one username.
//
// Neither check is a guess: both read existing data (an env var naming a specific project, and a
// column that already existed) or block — ownership is never inferred from anything else.

export type OwnershipResult = { ok: true } | { ok: false; error: string }

/** The one project slug allowed to publish through a platform's global credentials, from that
 * platform's own env var (e.g. INSTAGRAM_OWNER_PROJECT). Unset/blank -> null (fail closed below). */
export function resolveOwnerProjectSlug(envValue: string | undefined | null): string | null {
  return envValue?.trim().toLowerCase() || null
}

/**
 * The actual authorization check: is `requestedProjectSlug` the one project allowed to use this
 * platform's global credentials? `envVarName` is only used to name the fix in the error message.
 * Fails closed: no owner configured, or a slug that doesn't match it exactly, blocks publishing —
 * this app never infers or guesses which project a global credential belongs to.
 */
export function verifyProjectIsAllowed(
  platformLabel: string,
  envVarName: string,
  ownerProjectSlug: string | null,
  requestedProjectSlug: string | null,
): OwnershipResult {
  if (!ownerProjectSlug) {
    return {
      ok: false,
      error: `Cannot verify which project owns the global ${platformLabel} credentials: ` +
        `${envVarName} is not configured on the server. Set it to the single project slug ` +
        `allowed to publish through these credentials before publishing.`,
    }
  }
  const requested = requestedProjectSlug?.trim().toLowerCase() || null
  if (requested !== ownerProjectSlug) {
    return {
      ok: false,
      // Echoing the requested slug (not just the configured owner) is what makes this error
      // self-diagnosing: without it, a slug that merely differs by whitespace, casing kept as
      // typed, or an altogether different project looks identical to a real misconfiguration —
      // an admin seeing only the owner side has no way to tell which one is "wrong" without
      // reading server logs or this source file. Both sides are logged exactly as compared
      // (trimmed+lowercased), never the raw env var or raw request value, so this never risks
      // leaking anything beyond a project slug, which is not a secret.
      error: `This project is not the one allowed to use the global ${platformLabel} credentials ` +
        `(requested project: "${requested ?? '(none)'}", configured owner project: "${ownerProjectSlug}"). ` +
        `Refusing to publish — this would use another project's credentials.`,
    }
  }
  return { ok: true }
}

function normalizeHandle(value: string): string {
  return value.trim().toLowerCase().replace(/^@+/, '')
}

export function compareAccountOwnership(
  platformLabel: string,
  projectUsername: string | null | undefined,
  actualUsername: string | null | undefined,
): OwnershipResult {
  const expected = normalizeHandle(projectUsername ?? '')
  if (!expected) {
    return {
      ok: false,
      error: `Cannot verify this project owns the configured ${platformLabel} account: ` +
        `the project's social_accounts.username is not set. Set it to the exact @handle of this ` +
        `project's ${platformLabel} account before publishing.`,
    }
  }
  const actual = normalizeHandle(actualUsername ?? '')
  if (!actual) {
    return {
      ok: false,
      error: `Cannot verify this project owns the configured ${platformLabel} account: ` +
        `the ${platformLabel} API did not return a username to compare against.`,
    }
  }
  if (actual !== expected) {
    return {
      ok: false,
      error: `The configured ${platformLabel} account (@${actual}) does not match this project's ` +
        `connected account (@${expected}). Refusing to publish — this would post to another ` +
        `project's ${platformLabel} account.`,
    }
  }
  return { ok: true }
}
