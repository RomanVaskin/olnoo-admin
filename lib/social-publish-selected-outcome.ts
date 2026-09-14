// Pure, dependency-free piece of the "Publish selected channels" fan-out, pulled out purely so
// it's testable with the project's plain-.ts node:test runner (lib/social-publish-selected.ts
// itself needs the "@/..." alias for lib/crm, lib/social, and the four platform publishers, which
// node's native module resolution can't follow outside the Next.js build).

export type ChannelOutcome = 'published' | 'failed' | 'already_published'

/** The same two-shape result every existing publisher (Telegram/VK/Instagram/Threads) already
 * returns: a pre-flight problem (no account, no content, wrong platform, duplicate 409, …) as
 * {error, status}, or an actual attempt's resulting row as {row}. */
export type PublisherCallResult = { error: string; status: number } | { row: Record<string, unknown> }

/** Maps one publisher call's result to a fan-out outcome, without touching any of that publisher's
 * own logic. A 409 (this channel was already published — including a race where it got published
 * concurrently between the fan-out's own pre-filter and this call) is reported as
 * 'already_published', not 'failed'. Any other {error} — a genuine pre-flight problem such as a
 * missing Instagram image or no configured account — is reported as 'failed' with that channel's
 * own message. A {row} is 'published' or 'failed' exactly as the row's own status/error already
 * says (the same thing the individual "Publish to X" button already shows). */
export function outcomeFromPublisherResult(
  result: PublisherCallResult,
  fallbackExternalUrl: string,
): { outcome: ChannelOutcome; externalUrl: string; error: string } {
  if ('error' in result) {
    if (result.status === 409) return { outcome: 'already_published', externalUrl: fallbackExternalUrl, error: '' }
    return { outcome: 'failed', externalUrl: '', error: result.error }
  }
  const row = result.row
  if (row.status === 'published') {
    return { outcome: 'published', externalUrl: (row.external_url as string) || '', error: '' }
  }
  return { outcome: 'failed', externalUrl: '', error: (row.error as string) || 'Publish failed' }
}
