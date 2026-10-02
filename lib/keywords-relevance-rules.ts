// Pure rules for AI relevance cleanup of search queries (no DB, no network, no env) — unit-testable
// with node --test. The DB/job side lives in lib/keywords-relevance.ts.

export const RELEVANCE_STATUSES = ['target', 'informational', 'uncertain', 'geo_mismatch', 'irrelevant'] as const
export type RelevanceStatus = (typeof RELEVANCE_STATUSES)[number]

export function isRelevanceStatus(value: unknown): value is RelevanceStatus {
  return typeof value === 'string' && (RELEVANCE_STATUSES as readonly string[]).includes(value)
}

/**
 * Minimum AI confidence (0-100) for a status to be saved as the AI gave it; below it the saved
 * status becomes 'uncertain'. Thresholds differ because the errors are not equally costly: a
 * wrongly EXCLUDED query (irrelevant / geo_mismatch) silently drops real demand from clustering,
 * a wrongly INCLUDED one is visible in a cluster and harmless — so exclusion needs more certainty.
 * 'uncertain' is never downgraded. Not calibrated on real answers: re-tune after a first
 * run from the confidence distribution (it is the only place these numbers live).
 */
export const RELEVANCE_CONFIDENCE_THRESHOLDS: Record<Exclude<RelevanceStatus, 'uncertain'>, number> = {
  target: 55,
  informational: 55,
  geo_mismatch: 70,
  irrelevant: 70,
}

/** Unique queries per AI call: ~55 output tokens each ⇒ ~5.5k of the Router's 12 000 max output tokens. */
export const RELEVANCE_BATCH_SIZE = 100
/** Cap on the keyword list of one prompt. */
export const RELEVANCE_BATCH_MAX_CHARS = 12000
/** Pages listed in the project context, and chars kept per page field. */
export const RELEVANCE_CONTEXT_PAGES = 40
export const RELEVANCE_CONTEXT_FIELD_CHARS = 140
export const RELEVANCE_REASON_MAX_CHARS = 160
export const RELEVANCE_CONCURRENCY = 3

export type RelevanceDecision = { status: RelevanceStatus; confidence: number; reason: string; downgraded: boolean }

const DEFAULT_REASONS: Record<RelevanceStatus, string> = {
  target: 'Целевой запрос по услуге проекта',
  informational: 'Информационный запрос по теме проекта',
  uncertain: 'Нужно решение: запрос не удалось уверенно отнести к бизнесу',
  geo_mismatch: 'Указан регион, который проект не обслуживает',
  irrelevant: 'Запрос не относится к бизнесу проекта',
}

/** Applies the deterministic confidence rule: a status below its threshold is saved as 'uncertain'. */
export function applyConfidenceThreshold(status: RelevanceStatus, confidence: number): { status: RelevanceStatus; downgraded: boolean } {
  if (status === 'uncertain') return { status, downgraded: false }
  return confidence < RELEVANCE_CONFIDENCE_THRESHOLDS[status] ? { status: 'uncertain', downgraded: true } : { status, downgraded: false }
}

/** One short Russian sentence: single line, trimmed, capped; falls back to a stock reason when empty or not Russian. */
export function cleanReason(raw: unknown, status: RelevanceStatus): string {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : ''
  if (!text || !/[А-Яа-яЁё]/.test(text)) return DEFAULT_REASONS[status]
  return text.length > RELEVANCE_REASON_MAX_CHARS ? `${text.slice(0, RELEVANCE_REASON_MAX_CHARS - 1)}…` : text
}

/** Turns one validated AI answer into what is saved (threshold applied, reason cleaned). */
export function decide(status: RelevanceStatus, confidence: number, rawReason: unknown): RelevanceDecision {
  const applied = applyConfidenceThreshold(status, confidence)
  if (!applied.downgraded) return { status, confidence, reason: cleanReason(rawReason, status), downgraded: false }
  const original = cleanReason(rawReason, status)
  return {
    status: 'uncertain',
    confidence,
    reason: cleanReason(`Низкая уверенность AI (${confidence}%): ${original}`, 'uncertain'),
    downgraded: true,
  }
}

export type AiRelevanceItem = { keywordId: number; status: RelevanceStatus; confidence: number; reason: string }

function stripToJson(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  return t.trim()
}

/**
 * Validates one AI answer. Returns null when the answer as a whole is unusable (not JSON, no
 * `results` array, or not a single valid item) — the caller then fails that batch and saves nothing.
 * Single bad items (unknown id, unknown status, no numeric confidence, repeated id) are dropped;
 * the AI can never change a query: only ids that were sent are accepted and only the id is read back.
 */
export function parseRelevanceResponse(raw: string, sentIds: Set<number>): AiRelevanceItem[] | null {
  const text = stripToJson(raw)
  let data: unknown = null
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      data = JSON.parse(candidate)
      break
    } catch {
      // try the next candidate
    }
  }
  const results = data && typeof data === 'object' ? (data as Record<string, unknown>).results : undefined
  if (!Array.isArray(results)) return null

  const seen = new Set<number>()
  const items: AiRelevanceItem[] = []
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const id = Number(e.keyword_id)
    const status = typeof e.relevance_status === 'string' ? e.relevance_status.trim().toLowerCase() : ''
    const confidence = typeof e.confidence === 'number' ? e.confidence : Number(e.confidence)
    if (!Number.isInteger(id) || !sentIds.has(id) || seen.has(id)) continue
    if (!isRelevanceStatus(status) || !Number.isFinite(confidence)) continue
    seen.add(id)
    items.push({ keywordId: id, status, confidence: Math.max(0, Math.min(100, Math.round(confidence))), reason: typeof e.reason === 'string' ? e.reason : '' })
  }
  return items.length ? items : null
}

export const RELEVANCE_SYSTEM_PROMPT = `You classify Wordstat search queries by how relevant they are to ONE specific business website.

You get the business context (project name, domain, and compact data of its existing pages: url, title, h1, description) and a list of queries. Judge each query by its MEANING relative to what this business actually offers and where it works — never in a vacuum, never by shared words alone. Infer the business, its services/products and its region only from the given context; do not assume facts that are not there.

relevance_status — exactly one of:
- "target": the query is about a service/product the business offers (including a specific model, brand, car/object type, price, cost, "near me"-style commercial wording). Someone searching it could become a client.
- "informational": about the business topic but the searcher wants to learn (how, which is better, what is, instructions, reviews/comparisons), not to order.
- "uncertain": potentially relevant but you cannot tell from the context, or the business must decide — e.g. a segment the site does not clearly serve (commercial/special vehicles, taxi, fleets), buying the material/goods themselves when the site only provides a service, ambiguous wording.
- "geo_mismatch": about the business's service but explicitly tied to a city/region the business evidently does NOT serve according to its context. A city that IS the business's region is not a mismatch. If the business region is not evident from the context, use "uncertain", not "geo_mismatch".
- "irrelevant": has nothing to do with this business (other topics, other industries, unrelated products).

Rules:
1. Do not be aggressive. Being a "similar" query from Wordstat does NOT make a query irrelevant, and a popular one is not automatically a target. When in doubt prefer "uncertain" over "irrelevant"/"geo_mismatch".
2. Never change, correct or translate a query; you only return its keyword_id.
3. "confidence" is an integer 0-100: how sure you are of THIS status.
4. "reason" is ONE short sentence in RUSSIAN (at most 12 words) that a business owner can read, e.g. «Основная услуга проекта», «Указан регион вне региона проекта», «Запрос не относится к бизнесу проекта». No reasoning chains, no quotes of the query.
5. Return a result for EVERY keyword_id you were given, each exactly once.
6. Return ONLY strict JSON, no markdown, no commentary:
{"results":[{"keyword_id":number,"relevance_status":"target"|"informational"|"uncertain"|"geo_mismatch"|"irrelevant","confidence":number,"reason":string}]}`

export type ContextPage = { url: string; title: string | null; h1: string | null; description: string | null }

function clip(text: string | null | undefined): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > RELEVANCE_CONTEXT_FIELD_CHARS ? `${t.slice(0, RELEVANCE_CONTEXT_FIELD_CHARS - 1)}…` : t
}

function pagePath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname || '/'
  } catch {
    return url
  }
}

/** Compact project context from data that already exists: project name/domain and a capped page list. */
export function buildProjectContext(project: { name: string; domain: string }, pages: ContextPage[]): string {
  const lines = pages
    .filter((p) => p.title || p.h1 || p.description)
    .slice(0, RELEVANCE_CONTEXT_PAGES)
    .map((p) => {
      const bits = [pagePath(p.url)]
      if (p.title) bits.push(`title: ${clip(p.title)}`)
      if (p.h1) bits.push(`h1: ${clip(p.h1)}`)
      if (p.description) bits.push(`description: ${clip(p.description)}`)
      return `- ${bits.join(' | ')}`
    })
  return `PROJECT: ${project.name} (${project.domain})
PAGES (${lines.length}${pages.length > lines.length ? ` of ${pages.length}` : ''}):
${lines.length ? lines.join('\n') : '(no page data available — judge from the project name and domain only; prefer "uncertain" when the business or its region is unclear)'}`
}

export function buildRelevanceUserPrompt(context: string, items: { keywordId: number; query: string }[]): string {
  return `${context}

QUERIES (${items.length}) — format: keyword_id<TAB>query
${items.map((i) => `${i.keywordId}\t${i.query}`).join('\n')}

Classify every query and return the JSON described in your instructions.`
}

export type RelevanceGroup = { repId: number; query: string; ids: number[] }

/**
 * Groups keyword rows by identical query text (one row per Wordstat region) so each text is sent
 * to the AI once, then splits the groups into batches by count and prompt chars.
 */
export function planRelevanceBatches(
  rows: { id: number; query: string }[],
  { batchSize = RELEVANCE_BATCH_SIZE, maxChars = RELEVANCE_BATCH_MAX_CHARS }: { batchSize?: number; maxChars?: number } = {},
): RelevanceGroup[][] {
  const byText = new Map<string, RelevanceGroup>()
  for (const r of rows) {
    const key = r.query.trim().toLowerCase().replace(/\s+/g, ' ')
    const group = byText.get(key)
    if (group) group.ids.push(r.id)
    else byText.set(key, { repId: r.id, query: r.query.trim(), ids: [r.id] })
  }
  const batches: RelevanceGroup[][] = []
  let current: RelevanceGroup[] = []
  let chars = 0
  for (const group of byText.values()) {
    const size = group.query.length + 12
    if (current.length && (current.length >= batchSize || chars + size > maxChars)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(group)
    chars += size
  }
  if (current.length) batches.push(current)
  return batches
}

/**
 * Which keywords clustering takes, evaluated against live DB state when a run starts (never a
 * cleanup snapshot). `k` = keywords, `p` = projects. A project that never ran cleanup
 * (relevance_cleanup_at IS NULL) keeps the old behaviour — every keyword — except keywords a
 * person explicitly marked irrelevant / geo_mismatch. A project that uses cleanup takes only
 * target and informational: irrelevant, geo_mismatch, unresolved uncertain and not-yet-checked
 * keywords wait out.
 */
export const CLUSTERING_KEYWORD_FILTER_SQL = `(
  CASE WHEN p.relevance_cleanup_at IS NULL
    THEN (k.relevance_status IS NULL OR k.relevance_status NOT IN ('irrelevant', 'geo_mismatch'))
    ELSE k.relevance_status IN ('target', 'informational')
  END
)`
