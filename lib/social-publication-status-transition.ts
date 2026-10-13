// Pure, dependency-free piece of the publications API (same reasoning as
// lib/social-publish-selected-outcome.ts — lib/social-publications.ts itself needs the "@/..."
// alias for lib/crm/lib/social, which node's native module resolution can't follow outside the
// Next.js build).
//
// Root cause this fixes: every publisher (Telegram/VK/Instagram/Threads) refuses to re-send a
// publication whose status is already 'published' (a 409) — that guard is the ONLY thing standing
// between a retry and a duplicate post on the real platform. `PATCH /api/social-publications/[id]`
// (updateSocialPublication) let the UI set ANY status on ANY row, including moving an already-
// 'published' row back to 'ready' — which doesn't un-publish anything on Telegram/VK/Instagram/
// Threads, it just erases the ONE guard that prevented a next publish attempt (manual or, before
// this same change set's scheduler fix, automatic) from creating a second, duplicate post. The
// UI's own "Back to ready" button (components/sections/social-publications.tsx) was the only
// reachable path to this transition; it's removed in the same change, and this is the
// corresponding server-side refusal so the API itself can't be used to do the same thing.
//
// PR-2 extended the same reasoning to `'publishing'`, but only blocked `publishing → ready` —
// every other transition out of `'publishing'` (in particular `publishing → failed` and
// `publishing → published`) was still allowed via a plain PATCH, reasoning that only a human who
// had confirmed the real outcome on the platform would use it. That reasoning doesn't hold: this
// plain `PATCH /api/social-publications/[id]` has no way to tell "this row is genuinely stuck
// (the process that claimed it crashed or lost its connection long ago)" apart from "this row is
// ACTIVELY being sent right now by the request that holds the claim". If ANY caller — an admin's
// stray click, a stale browser tab, a script — PATCHes `status: 'failed'` while the real send is
// still genuinely in flight, the row leaves `'publishing'` and re-satisfies
// `claimPublicationForSending`'s `WHERE status NOT IN ('publishing', 'published')`: a second,
// fully independent claim can now succeed and call the platform's send API a second time, WHILE
// the first attempt is still running — a real duplicate post, the exact risk the atomic claim was
// built to prevent in the first place. So `'publishing'` is now fully immutable through this
// generic status PATCH, in every direction, not just `→ ready`. The only way out is the
// publisher's own internal final write (its own success/failure UPDATE, which this function has
// no say over) once its one claimed attempt actually finishes. A row that's genuinely, permanently
// stuck (the process that claimed it crashed and nothing will ever write its final result) has no
// in-app recovery path at all as of this fix — it requires a direct database operation by someone
// who has independently confirmed the real outcome on the platform itself, same as any other rare
// operational incident; that's an explicit, accepted trade-off, not an oversight.

/** True whenever this app must never allow the transition: ANY transition away from
 * `'publishing'` (a concurrent attempt in flight, or a stuck row whose real outcome is unknown —
 * see the module comment for why even `→ failed` isn't safe here), or `'published' → 'ready'`
 * (this platform already has the real post; moving it back to `'ready'` would silently re-enable a
 * next publish attempt to recreate it). Every other transition (draft→ready, ready→published,
 * published→failed, failed→ready, …) is unaffected. */
export function isForbiddenPublicationStatusTransition(currentStatus: string, nextStatus: string): boolean {
  if (currentStatus === 'publishing') return true
  return currentStatus === 'published' && nextStatus === 'ready'
}
