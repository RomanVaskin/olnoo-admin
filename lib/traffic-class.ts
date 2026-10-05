// Traffic classification of CRM leads (Test Traffic v1, step A — the foundation). Pure: no DB, no `@/` imports.
//
// A lead is REAL, TEST or UNKNOWN. The automatic class (`auto` + `reason`) is decided at intake; a human may override it
// (`override`, REAL or TEST); the EFFECTIVE class is `override ?? auto`. Step A knows exactly one automatic source — the
// historical explicit UTM markers of known test traffic — and defaults everything else to UNKNOWN: nothing is promoted to
// REAL automatically. (Planned for later steps, NOT active here: signed test sessions, instrumented-web default,
// known test contacts, invalid-token handling.)

export const TRAFFIC_CLASSES = ['REAL', 'TEST', 'UNKNOWN'] as const
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number]
export type TrafficOverride = Exclude<TrafficClass, 'UNKNOWN'>

export const TRAFFIC_REASON_LEGACY_MARKER = 'legacy_utm_marker'
export const TRAFFIC_REASON_UNCLASSIFIED = 'unclassified'
export type TrafficClassReason = typeof TRAFFIC_REASON_LEGACY_MARKER | typeof TRAFFIC_REASON_UNCLASSIFIED

export type TrafficMarkers = { readonly utmContent: readonly string[]; readonly utmTerm: readonly string[] }

/**
 * The explicit, project-specific markers of the known historical test traffic. Exact normalised comparison (trim +
 * lower-case), OR across the two fields; never a substring or regex rule. Shared with Unified's test-traffic rule.
 */
export const LEGACY_TEST_MARKERS: Readonly<Record<string, TrafficMarkers>> = {
  driveset: { utmContent: ['a2_production_test'], utmTerm: ['test_attribution'] },
}

const normalize = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()

export function matchesLegacyMarker(project: string, utmContent: string | null | undefined, utmTerm: string | null | undefined): boolean {
  if (!Object.prototype.hasOwnProperty.call(LEGACY_TEST_MARKERS, project)) return false
  const markers = LEGACY_TEST_MARKERS[project]
  const content = normalize(utmContent)
  const term = normalize(utmTerm)
  return (content !== '' && markers.utmContent.some((m) => normalize(m) === content)) || (term !== '' && markers.utmTerm.some((m) => normalize(m) === term))
}

export type AutoClassification = { auto: TrafficClass; reason: TrafficClassReason }

/** Intake classification. Only the historical explicit markers give TEST; everything else is UNKNOWN — never REAL. */
export function classifyLead(input: { project: string; utmContent?: string | null; utmTerm?: string | null }): AutoClassification {
  if (matchesLegacyMarker(input.project, input.utmContent, input.utmTerm)) return { auto: 'TEST', reason: TRAFFIC_REASON_LEGACY_MARKER }
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
