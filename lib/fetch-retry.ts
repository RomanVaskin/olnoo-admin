// Fetch with a timeout and a few attempts, for the Pages sync (sitemap + page HTML). Only transient
// failures are retried: network errors, timeouts, HTTP 5xx and 429. Other 4xx are permanent and returned at once.

export const FETCH_ATTEMPTS = 3
export const FETCH_TIMEOUT_MS = 9_000
const RETRY_DELAY_MS = 1_000

export type RetryOptions = {
  attempts?: number
  timeoutMs?: number
  /** Pause before attempt n+1 is n × this value (1 s, 2 s by default). Tests pass 0. */
  retryDelayMs?: number
  /** Prefix of the journald lines ("[tag] …"); default `pages-sync`. */
  logTag?: string
}

export class FetchRetryError extends Error {
  attempts: number
  constructor(message: string, attempts: number) {
    super(message)
    this.attempts = attempts
  }
}

const isTransientStatus = (status: number) => status >= 500 || status === 429

function describe(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout'
    const cause = (err as { cause?: { code?: string; message?: string } }).cause
    return cause?.code ?? cause?.message ?? err.message
  }
  return String(err)
}

/**
 * Fetches `url` and reads the body inside the timeout. Returns `{ status, ok, text }` for any HTTP answer that is
 * final (success, or a permanent 4xx); retries transient failures and throws FetchRetryError, naming the url,
 * the number of attempts and the last reason, when every attempt failed.
 */
export async function fetchTextWithRetry(
  url: string,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<{ status: number; ok: boolean; text: string; headers: Headers }> {
  const attempts = opts.attempts ?? FETCH_ATTEMPTS
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const delay = opts.retryDelayMs ?? RETRY_DELAY_MS
  const tag = opts.logTag ?? 'pages-sync'
  let reason = 'unknown error'

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
      if (!isTransientStatus(res.status)) {
        const text = await res.text()
        // Journald line per recovered fetch: shows how often the network path really fails before a fix is chosen.
        if (attempt > 1) console.warn(`[${tag}] ${url}: ok on attempt ${attempt} after ${attempt - 1} failed (last: ${reason})`)
        return { status: res.status, ok: res.ok, text, headers: res.headers }
      }
      reason = `HTTP ${res.status}`
    } catch (err) {
      reason = describe(err)
    }
    if (attempt < attempts && delay > 0) await new Promise((r) => setTimeout(r, delay * attempt))
  }
  console.error(`[${tag}] ${url}: all ${attempts} attempts failed (last: ${reason})`)
  throw new FetchRetryError(`${url}: ${reason} after ${attempts} attempts`, attempts)
}
