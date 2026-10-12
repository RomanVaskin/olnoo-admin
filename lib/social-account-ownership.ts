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
// The only existing signal that can settle this without a migration is `social_accounts.username`
// (already documented, in lib/social-instagram.ts/lib/social-threads.ts, as "the real @handle,
// never a token or numeric id"). This module compares it against the actual handle the global
// credentials are connected to — one cheap read-only API call the caller makes with its own
// already-validated token, same call shape (`GET /{id}?fields=...&access_token=...`) those files
// already use elsewhere. A blank `username` or a mismatch blocks publishing outright: ownership
// is confirmed from existing data or publishing is refused, never guessed.

export type OwnershipResult = { ok: true } | { ok: false; error: string }

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
