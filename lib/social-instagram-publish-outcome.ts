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
  | { status: 'published'; externalPostId: string; externalUrl: string }

/**
 * `mediaId` is the id returned by a successful `media_publish` call (null if that step never
 * succeeded — the one genuine failure case). `permalink` is the best-effort result of the
 * following read-back call (null if it wasn't fetched or came back empty). `igError` is whatever
 * error message was captured during the whole attempt, from ANY step — it is only used when
 * `mediaId` is null; once `mediaId` is set, the post has already been published, so no error from
 * this point on (in particular, a permalink lookup failure) can turn that into a reported failure.
 */
export function resolveInstagramPublishOutcome(
  mediaId: string | null,
  permalink: string | null,
  igError: string | null,
): InstagramPublishOutcome {
  if (!mediaId) {
    return { status: 'failed', error: igError || 'Instagram did not return a published media id' }
  }
  return { status: 'published', externalPostId: mediaId, externalUrl: permalink || '' }
}
