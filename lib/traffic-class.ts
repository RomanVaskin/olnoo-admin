// Traffic classification of CRM leads (Test Traffic v1). Pure: no DB, no `@/` imports.
//
// A lead is REAL, TEST or UNKNOWN. The automatic class (`auto` + `reason`) is decided at intake; a human may override it
// (`override`, REAL or TEST); the EFFECTIVE class is `override ?? auto`.
//
// TEST  — the explicit test UTM (utm_source=olnoo AND utm_medium=test), the historical DriveSet markers, or a known test
//         contact of the team.
// REAL  — ONLY a lead that came through the trusted DriveSet inbound API at or after the project's activation boundary
//         and carries no test marker. "No marker" alone is never enough: older leads and every other path stay UNKNOWN.
// UNKNOWN — everything else (Telegram, phone, leads typed into the Admin UI, anything before the boundary).
// Specific fields are compared exactly (normalised); there is no substring/regex matching and no look at other payload fields.

export const TRAFFIC_CLASSES = ['REAL', 'TEST', 'UNKNOWN'] as const
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number]
export type TrafficOverride = Exclude<TrafficClass, 'UNKNOWN'>

export const TRAFFIC_REASON_TEST_UTM = 'test_utm'
export const TRAFFIC_REASON_LEGACY_MARKER = 'legacy_utm_marker'
export const TRAFFIC_REASON_KNOWN_CONTACT = 'known_test_contact'
export const TRAFFIC_REASON_WEB_AFTER_ACTIVATION = 'web_after_activation'
export const TRAFFIC_REASON_UNCLASSIFIED = 'unclassified'
export type TrafficClassReason =
  | typeof TRAFFIC_REASON_TEST_UTM
  | typeof TRAFFIC_REASON_LEGACY_MARKER
  | typeof TRAFFIC_REASON_KNOWN_CONTACT
  | typeof TRAFFIC_REASON_WEB_AFTER_ACTIVATION
  | typeof TRAFFIC_REASON_UNCLASSIFIED

// ---- the test UTM (what the Test Link generator produces) ---------------------------------------------

export const TEST_UTM_SOURCE = 'olnoo'
export const TEST_UTM_MEDIUM = 'test'
export const TEST_UTM_CONTENT = 'olnoo_test'
/** (source, medium) pairs that mark test traffic. Both must match; `utm_content` / `utm_term` are free (term = session id). */
export const TEST_UTM_PAIRS: readonly { readonly source: string; readonly medium: string }[] = [{ source: TEST_UTM_SOURCE, medium: TEST_UTM_MEDIUM }]

export type TrafficMarkers = { readonly utmContent: readonly string[]; readonly utmTerm: readonly string[] }

/** The historical explicit DriveSet markers (kept so old data is still recognised). */
export const LEGACY_TEST_MARKERS: Readonly<Record<string, TrafficMarkers>> = {
  driveset: { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'] },
}

const normalize = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

export function matchesTestUtm(utmSource: string | null | undefined, utmMedium: string | null | undefined): boolean {
  const source = normalize(utmSource)
  const medium = normalize(utmMedium)
  return source !== '' && medium !== '' && TEST_UTM_PAIRS.some((p) => normalize(p.source) === source && normalize(p.medium) === medium)
}

export function matchesLegacyMarker(project: string, utmContent: string | null | undefined, utmTerm: string | null | undefined): boolean {
  if (!Object.prototype.hasOwnProperty.call(LEGACY_TEST_MARKERS, project)) return false
  const markers = LEGACY_TEST_MARKERS[project]
  const content = normalize(utmContent)
  const term = normalize(utmTerm)
  return (content !== '' && markers.utmContent.some((m) => normalize(m) === content)) || (term !== '' && markers.utmTerm.some((m) => normalize(m) === term))
}

// ---- known test contacts (server env only; no personal data in Git) --------------------------------------

/**
 * Format of `OLNOO_TEST_CONTACTS_DRIVESET`: a list separated by commas, semicolons or newlines (spaces inside a phone are fine). Each entry is a
 * phone number in any common formatting (`+7 999 123-45-67`, `89991234567`, `9991234567` — Russian 8/7/10-digit forms are
 * unified) or a Telegram numeric id written `tg:<id>` (exactly what the CRM stores in `leads.contact` for Telegram
 * Business leads). Anything else in the list is ignored. Matching is exact on the normalised value.
 */
export function normalizeContact(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toLowerCase()
  const tg = /^tg:(\d{3,20})$/.exec(v)
  if (tg) return `tg:${tg[1]}`
  if (!/^[+\d][\d\s().-]*$/.test(v)) return null
  let digits = v.replace(/\D/g, '')
  if (digits.length === 10) digits = `7${digits}`
  if (digits.length === 11 && digits.startsWith('8')) digits = `7${digits.slice(1)}`
  return digits.length >= 10 && digits.length <= 15 ? `phone:${digits}` : null
}

export function parseKnownContacts(raw: string | null | undefined): Set<string> {
  const out = new Set<string>()
  for (const part of (raw ?? '').split(/[,;\n]+/)) {
    const n = normalizeContact(part)
    if (n) out.add(n)
  }
  return out
}

// ---- activation boundary -------------------------------------------------------------------------------

/**
 * `DRIVESET_TEST_CLASSIFICATION_SINCE` — an ISO 8601 timestamp WITH a time zone offset (e.g. `2026-10-06T09:30:00+03:00`):
 * the moment REAL classification of trusted web leads starts. Absent or malformed → null → nothing is classified REAL
 * (fail-safe: those leads stay UNKNOWN). Returns ms since epoch.
 */
export function parseActivationBoundary(raw: string | null | undefined): number | null {
  const v = (raw ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}

/** Per-project configuration (explicit; the next project is one more entry). */
export const TRAFFIC_CLASS_PROJECTS: Readonly<Record<string, { activationEnv: string; contactsEnv: string }>> = {
  driveset: { activationEnv: 'DRIVESET_TEST_CLASSIFICATION_SINCE', contactsEnv: 'OLNOO_TEST_CONTACTS_DRIVESET' },
}

// ---- classifier ------------------------------------------------------------------------------------------

/** Where a lead came from. Only the authenticated inbound API (DriveSet's server) is trusted to mean "a real web visitor". */
export type LeadIntake = 'inbound_api'

export type AutoClassification = { auto: TrafficClass; reason: TrafficClassReason }

export function classifyLead(input: {
  project: string
  intake?: LeadIntake
  utmSource?: string | null
  utmMedium?: string | null
  utmContent?: string | null
  utmTerm?: string | null
  phone?: string | null
  contact?: string | null
  /** Intake time in ms (injectable for tests). */
  now?: number
  env?: Record<string, string | undefined>
}): AutoClassification {
  const config = Object.prototype.hasOwnProperty.call(TRAFFIC_CLASS_PROJECTS, input.project) ? TRAFFIC_CLASS_PROJECTS[input.project] : null
  const env = input.env ?? process.env

  if (matchesTestUtm(input.utmSource, input.utmMedium)) return { auto: 'TEST', reason: TRAFFIC_REASON_TEST_UTM }
  if (matchesLegacyMarker(input.project, input.utmContent, input.utmTerm)) return { auto: 'TEST', reason: TRAFFIC_REASON_LEGACY_MARKER }

  if (config) {
    const known = parseKnownContacts(env[config.contactsEnv])
    if (known.size > 0) {
      for (const candidate of [input.phone, input.contact]) {
        const n = normalizeContact(candidate)
        if (n && known.has(n)) return { auto: 'TEST', reason: TRAFFIC_REASON_KNOWN_CONTACT }
      }
    }
    const since = parseActivationBoundary(env[config.activationEnv])
    if (input.intake === 'inbound_api' && since !== null && (input.now ?? Date.now()) >= since) {
      return { auto: 'REAL', reason: TRAFFIC_REASON_WEB_AFTER_ACTIVATION }
    }
  }
  return { auto: 'UNKNOWN', reason: TRAFFIC_REASON_UNCLASSIFIED }
}

/** A stored value read back from the database: anything outside the enum is treated as UNKNOWN (the safe class). */
export function parseTrafficClass(value: unknown): TrafficClass {
  return typeof value === 'string' && (TRAFFIC_CLASSES as readonly string[]).includes(value) ? (value as TrafficClass) : 'UNKNOWN'
}

/** The override column only holds REAL | TEST; anything else (including NULL) means "no override". */
export function parseTrafficOverride(value: unknown): TrafficOverride | null {
  return value === 'REAL' || value === 'TEST' ? value : null
}

/** effective = override ?? auto. A manual decision always wins; clearing it (null) restores the automatic class. */
export function effectiveTrafficClass(auto: unknown, override: unknown): TrafficClass {
  return parseTrafficOverride(override) ?? parseTrafficClass(auto)
}
