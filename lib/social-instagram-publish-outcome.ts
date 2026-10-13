// Pure, dependency-free piece of Instagram publishing (same reasoning as
// lib/social-publish-selected-outcome.ts — lib/social-instagram.ts itself needs the "@/..." alias
// for lib/crm/lib/social/lib/social-account-ownership, which node's native module resolution can't
// follow outside the Next.js build).
//
// Root cause this fixes: Instagram's content-publishing flow is create container → poll until
// finished → media_publish (this is the actual, irreversible "post it" call) → best-effort read
// back the permalink. The row was previously marked `status = 'failed'` if EITHER media_publish
// itself failed OR the trailing permalink lookup failed/returned nothing — but by the time the
// permalink lookup runs, media_publish has already succeeded: the post is live on Instagram. Two
// consequences: (1) the admin sees "failed" for a post that actually went out, and (2) far worse,
// a 'failed' row doesn't trip the "already published" (409) guard every publisher has, so either a
// manual retry or (before this same change set's scheduler fix) an automatic scheduler retry would
// call media_publish AGAIN — publishing the same content to Instagram a second time. Threads'
// publisher (lib/social-threads.ts) already got this right (its own permalink lookup failure never
// sets its error variable at all); this pulls that same decision into one pure, directly-tested
// function and makes Instagram use it too — not a new design.

export type InstagramPublishOutcome =
  | { status: 'failed'; error: string }
  | { status: 'unknown'; error: string }
  | { status: 'published'; externalPostId: string; externalUrl: string }

/**
 * `mediaId` is the id returned by a successful `media_publish` call (null if that step never
 * succeeded). `permalink` is the best-effort result of the following read-back call (null if it
 * wasn't fetched or came back empty). `igError` is whatever error message was captured during the
 * whole attempt, from ANY step — it is only used when `mediaId` is null; once `mediaId` is set,
 * the post has already been published, so no error from this point on (in particular, a permalink
 * lookup failure) can turn that into a reported failure.
 *
 * PR-2: `sendOutcomeUnknown` is true ONLY when the `media_publish` call itself — the one
 * irreversible "post it" step — never got a response from Instagram at all (its own `fetch()`
 * threw: a timeout, a dropped connection). In that one specific case the real outcome is genuinely
 * unknown — the content may or may not have actually been posted — so this must be reported as
 * `'unknown'`, never `'failed'`: a `'failed'` row doesn't trip the "already published" 409 guard
 * (or, post-PR-2, `lib/social-publication-claim.ts`'s atomic claim), so a later retry — automatic
 * or manual — could call `media_publish` again and create a real duplicate post. A failure in an
 * EARLIER step (container creation, the processing poll) is still safely `'failed'`, whatever its
 * own cause — nothing has been posted yet at that point, regardless of why that step failed, so
 * retrying is always safe.
 */
export function resolveInstagramPublishOutcome(
  mediaId: string | null,
  permalink: string | null,
  igError: string | null,
  sendOutcomeUnknown: boolean,
): InstagramPublishOutcome {
  if (mediaId) {
    return { status: 'published', externalPostId: mediaId, externalUrl: permalink || '' }
  }
  if (sendOutcomeUnknown) {
    return { status: 'unknown', error: igError || 'Could not confirm whether Instagram received the publish request' }
  }
  return { status: 'failed', error: igError || 'Instagram did not return a published media id' }
}
