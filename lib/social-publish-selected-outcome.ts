// Pure, dependency-free piece of the "Publish selected channels" fan-out, pulled out purely so
// it's testable with the project's plain-.ts node:test runner (lib/social-publish-selected.ts
// itself needs the "@/..." alias for lib/crm, lib/social, and the four platform publishers, which
// node's native module resolution can't follow outside the Next.js build).

export type ChannelOutcome = 'published' | 'failed' | 'already_published' | 'unknown'

/** The same two-shape result every existing publisher (Telegram/VK/Instagram/Threads) already
 * returns: a pre-flight problem (no account, no content, wrong platform, duplicate/claim-conflict
 * 409, an unconfirmable send 503, …) as {error, status}, or an actual attempt's resulting row as
 * {row}. */
export type PublisherCallResult = { error: string; status: number } | { row: Record<string, unknown> }

/** Maps one publisher call's result to a fan-out outcome, without touching any of that publisher's
 * own logic.
 * - A 409 — this channel was already published, OR `lib/social-publication-claim.ts`'s atomic
 *   claim refused it (a concurrent attempt is mid-flight, or it's a previously-stuck row) — is
 *   reported as 'already_published', not 'failed': in every 409 case, something else already has
 *   or had this channel, and there is nothing for this call to do about it.
 * - A 503 means the publisher could not confirm whether the platform actually received the send
 *   (a timeout, a dropped connection — see each publisher's own "unknown" branch): reported as
 *   'unknown', never 'failed' — the row itself was deliberately left at `'publishing'` rather than
 *   written to a status that would (wrongly) read as "safe to retry".
 * - Any other {error} — a genuine pre-flight problem such as a missing Instagram image or no
 *   configured account — is reported as 'failed' with that channel's own message.
 * - A {row} is 'published' or 'failed' exactly as the row's own status/error already says (the
 *   same thing the individual "Publish to X" button already shows).
 */
export function outcomeFromPublisherResult(
  result: PublisherCallResult,
  fallbackExternalUrl: string,
): { outcome: ChannelOutcome; externalUrl: string; error: string } {
  if ('error' in result) {
    if (result.status === 409) return { outcome: 'already_published', externalUrl: fallbackExternalUrl, error: '' }
    if (result.status === 503) return { outcome: 'unknown', externalUrl: '', error: result.error }
    return { outcome: 'failed', externalUrl: '', error: result.error }
  }
  const row = result.row
  if (row.status === 'published') {
    return { outcome: 'published', externalUrl: (row.external_url as string) || '', error: '' }
  }
  return { outcome: 'failed', externalUrl: '', error: (row.error as string) || 'Publish failed' }
}
