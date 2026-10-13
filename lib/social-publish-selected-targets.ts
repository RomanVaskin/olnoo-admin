// Pure, dependency-free piece of the "Publish selected channels" fan-out (same reasoning as
// lib/social-publish-selected-outcome.ts — lib/social-publish-selected.ts itself needs the "@/..."
// alias for lib/crm/lib/social/the four platform publishers, which node's native module
// resolution can't follow outside the Next.js build).
//
// Root cause this fixes: the scheduler (lib/social-scheduler.ts) and the manual "Publish selected
// channels" button (app/api/social-publications/publish-selected/route.ts) both call
// publishSelectedChannels with no distinction between them — every not-yet-published
// social_publications row, INCLUDING one already marked 'failed' from a previous attempt, was
// retried on every single call. For the scheduler, which re-runs every minute, that meant a
// publication stuck on a genuine, durable failure (bad credentials, missing content, a platform
// rejecting the content outright) was retried forever, automatically, with no way for it to ever
// stop short of a human fixing the underlying cause AND manually clearing it. A manual retry
// (the admin clicking "Publish selected channels" or a per-channel "Publish to X" button again,
// after having addressed — or at least decided to re-attempt — a KNOWN failure) is a different,
// intentional action and must still work exactly as before.

/**
 * Decides whether one publication target should be attempted by THIS call of
 * publishSelectedChannels. `retryFailed` is the caller's own choice: the manual bulk-publish route
 * defaults it to `true` (preserve existing behavior — a human retrying is always allowed to retry
 * a known failure), while the scheduler passes `false` so it never automatically re-attempts a
 * publication already marked 'failed'. An already-'published' target is unaffected either way —
 * it's filtered out separately, upstream, as 'already_published'.
 */
export function shouldAttemptPublicationTarget(status: string, retryFailed: boolean): boolean {
  return retryFailed || status !== 'failed'
}
