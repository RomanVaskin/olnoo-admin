// Tiny, JSX-free piece of the Publications UI's button logic, pulled out purely so it's testable
// with the project's plain-.ts node:test runner (components/*.tsx can't be imported there — JSX
// isn't valid input for --experimental-strip-types, which only strips types, not syntax).

/** Whether ANY "publish"-type action (the per-platform automated button, or the manual "Mark as
 * published" fallback) should be offered at all for a publication in this status. `'published'` is
 * excluded for the obvious reason (nothing left to do); `'publishing'` (PR-2) is excluded because
 * every attempt is gated by `lib/social-publication-claim.ts`'s atomic claim anyway — offering the
 * button would just invite a click that's always refused with 409, for a row whose real outcome
 * (if it's genuinely stuck, not just slow) can only be resolved by a human checking the platform
 * directly, never by clicking publish again. */
export function shouldShowPublishButton(status: string): boolean {
  return status !== 'published' && status !== 'publishing'
}

/** Same rule the Telegram/VK/Instagram branches already use inline in social-publications.tsx:
 * the automated "Publish to <platform>" button only replaces the manual "Mark as published"
 * button for a Threads publication that's actually eligible to be published. */
export function shouldShowThreadsPublishButton(platform: string, status: string): boolean {
  return platform === 'threads' && shouldShowPublishButton(status)
}

/** The single "Publish selected channels" button only makes sense while there's at least one
 * selected channel that isn't published yet — once every selected channel is published
 * (summary === 'fully_published'), there is nothing left for it to do. */
export function shouldShowPublishSelectedButton(visibleChannelCount: number, summary: string): boolean {
  return visibleChannelCount > 0 && summary !== 'fully_published'
}
