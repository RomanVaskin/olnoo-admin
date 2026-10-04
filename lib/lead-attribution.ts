// Validation of the optional attribution identifiers a client may send with a lead. Pure (no DB, no
// `@/` imports) so it runs under `node --test`. Every field is optional: null / undefined / "" simply
// mean "not provided" and never block a lead. A value that IS provided but malformed is rejected, and
// the message never echoes it — these identifiers must not reach logs or error texts.

export type LeadAttributionInput = {
  leadTrackingId?: unknown
  metrikaClientId?: unknown
  yclid?: unknown
  firstSeenAt?: unknown
}

export type LeadAttribution = {
  leadTrackingId: string | null
  metrikaClientId: string | null
  yclid: string | null
  /** ISO UTC instant, ready for a timestamptz parameter. */
  firstSeenAt: string | null
}

export type LeadAttributionError = { error: string; status: 400 }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Metrika ClientID is a UInt64: digits only, at most 20 of them. Kept as a string — never converted to Number. */
const CLIENT_ID_RE = /^\d{1,20}$/
const YCLID_MAX = 200
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/
const MIN_FIRST_SEEN_MS = Date.parse('2020-01-01T00:00:00Z')
const MAX_FUTURE_MS = 24 * 60 * 60 * 1000

/** Date.parse is lenient (it rolls 2026-02-30 over to March and accepts T24:00), so the calendar fields are checked first. */
function isRealTimestamp(v: string): boolean {
  const m = TIMESTAMP_RE.exec(v)
  if (!m) return false
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number)
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59
}

const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

export function parseLeadAttribution(input: LeadAttributionInput, now: number = Date.now()): LeadAttribution | LeadAttributionError {
  const out: LeadAttribution = { leadTrackingId: null, metrikaClientId: null, yclid: null, firstSeenAt: null }

  if (!isBlank(input.leadTrackingId)) {
    const v = typeof input.leadTrackingId === 'string' ? input.leadTrackingId.trim() : ''
    if (!UUID_RE.test(v)) return { error: 'lead_tracking_id must be a UUID', status: 400 }
    out.leadTrackingId = v.toLowerCase()
  }

  if (!isBlank(input.metrikaClientId)) {
    // A JSON number may already have lost precision: only strings are accepted.
    const v = typeof input.metrikaClientId === 'string' ? input.metrikaClientId.trim() : ''
    if (!CLIENT_ID_RE.test(v)) return { error: 'metrika_client_id must be a string of 1-20 digits', status: 400 }
    out.metrikaClientId = v
  }

  if (!isBlank(input.yclid)) {
    const v = typeof input.yclid === 'string' ? input.yclid.trim() : ''
    // No whitespace or control characters; opaque otherwise, so no assumption about Yandex's format.
    if (!v || v.length > YCLID_MAX || /[\s\u0000-\u001f\u007f]/.test(v)) return { error: 'yclid is invalid', status: 400 }
    out.yclid = v
  }

  if (!isBlank(input.firstSeenAt)) {
    const v = typeof input.firstSeenAt === 'string' ? input.firstSeenAt.trim() : ''
    const ms = isRealTimestamp(v) ? Date.parse(v) : NaN
    if (!Number.isFinite(ms) || ms < MIN_FIRST_SEEN_MS || ms > now + MAX_FUTURE_MS) {
      return { error: 'first_seen_at must be an ISO 8601 timestamp with a time zone offset', status: 400 }
    }
    out.firstSeenAt = new Date(ms).toISOString()
  }

  return out
}
