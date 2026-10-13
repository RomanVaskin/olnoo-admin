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
// PR-2 extends the same reasoning to `'publishing'`: `lib/social-publication-claim.ts`'s atomic
// claim is what keeps a 'publishing' row from ever being auto- or manually re-attempted while it's
// genuinely in flight or stuck — moving it to 'ready' via a plain PATCH would erase that guard
// exactly the same way `published → ready` did, re-enabling an attempt on a row whose real-world
// outcome is still unconfirmed. There is still no UI path to this — PR-2 doesn't add one — so this
// is a server-side-only refusal, for the same defense-in-depth reason as the `published` case.

/** True exactly for the two transitions this app must never allow: a publication that is already
 * `'published'`, or one that is `'publishing'` (a concurrent attempt in flight, or a stuck row
 * whose real outcome is unknown), moving to `'ready'`. Every other transition (draft→ready,
 * ready→published, published→failed, failed→ready, publishing→failed, publishing→published, …) is
 * unaffected — this is not a blanket lock on either status, only on the specific transition that
 * would silently re-enable a duplicate publish attempt. */
export function isForbiddenPublicationStatusTransition(currentStatus: string, nextStatus: string): boolean {
  if (nextStatus !== 'ready') return false
  return currentStatus === 'published' || currentStatus === 'publishing'
}
