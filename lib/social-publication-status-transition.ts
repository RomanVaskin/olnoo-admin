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

/** True exactly for the one transition this app must never allow: a publication that is already
 * `'published'` moving to `'ready'`. Every other transition (draft→ready, ready→published,
 * published→failed, failed→ready, …) is unaffected — this is not a blanket lock on `published`
 * rows, only on the specific transition that would silently re-enable a duplicate publish. */
export function isForbiddenPublicationStatusTransition(currentStatus: string, nextStatus: string): boolean {
  return currentStatus === 'published' && nextStatus === 'ready'
}
