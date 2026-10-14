// Zero imports, by design: this constant is shared between a server-only module
// (lib/social-meta-token-refresh-sweep.ts, which pulls in `pg` and the crypto/refresh clients) and
// a 'use client' component (components/sections/social-accounts-view.tsx, for its "expires in N
// day(s)" warning threshold). Importing the constant straight out of the sweep module would drag
// the whole server-only module — Postgres client, decrypt/refresh network calls — into the client
// bundle just to read one number. Keeping it here, with nothing else in the file, means the client
// bundle only ever sees this one export.

/** How many days before expiry a per-account Instagram/Threads token is treated as "expiring
 * soon" — both lib/social-meta-token-refresh-sweep.ts's own selection window and the Accounts
 * UI's warning threshold, so the two can never drift apart. */
export const REFRESH_WINDOW_DAYS = 7
