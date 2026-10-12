// Pure, dependency-free helpers for Social Overview's metrics, split out of lib/social-overview.ts
// (which needs `@/lib/db`/`@/lib/crm`) so this is directly unit-testable with the project's plain
// node:test runner — same reasoning as lib/social-scheduler-due.ts and the other dependency-free
// Social helpers.
//
// Deliberate decision (requirement: "не объединять ошибки подключений и публикаций без явного
// разделения"): a social_accounts row's own `status = 'error'` (the account lost its VK/Telegram
// connection — see lib/social-accounts-vk-connection.ts / lib/social-accounts-telegram-connection.ts)
// and a social_publications row's `status = 'failed'` (one specific post failed to publish) are
// different failure classes about different things. They are never summed into one "errors"
// number. Connection-error counts stay attached to the account breakdown they come from
// (summarizeAccountStatusCounts, below); the Overview's own "Ошибки публикаций" metric counts only
// publication failures (a separate, explicit COUNT query in lib/social-overview.ts). Nothing here
// invents a combined figure.

export type AccountStatusCounts = {
  total: number
  connected: number
  error: number
  created: number
}

/** Reduces a `GROUP BY status` result from `social_accounts` into named counts. Any status value
 * this app doesn't know about (shouldn't happen — social_accounts.status is only ever written as
 * 'created'/'connected'/'error') still counts toward `total`, so the total never silently
 * undercounts a row just because its status wasn't one of the three named buckets. */
export function summarizeAccountStatusCounts(rows: { status: string; count: number }[]): AccountStatusCounts {
  const result: AccountStatusCounts = { total: 0, connected: 0, error: 0, created: 0 }
  for (const row of rows) {
    result.total += row.count
    if (row.status === 'connected') result.connected += row.count
    else if (row.status === 'error') result.error += row.count
    else if (row.status === 'created') result.created += row.count
  }
  return result
}
