import { Pool } from 'pg'

declare global {
  // eslint-disable-next-line no-var
  var __olnooPgPool: Pool | undefined
}

// Reused across hot reloads in dev so we don't open a new pool per request.
export const pool =
  global.__olnooPgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
  })

if (process.env.NODE_ENV !== 'production') {
  global.__olnooPgPool = pool
}
