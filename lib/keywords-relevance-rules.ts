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

/** Unique queries per AI call. */
export const RELEVANCE_BATCH_SIZE = 100
/**
 * Output budget of one cleanup call, derived from the batch instead of the Router's generic 12 000:
 * worst case every row carries a reason — id (≤3 tokens) + code + confidence + punctuation (~10) plus
 * a ≤12-word Russian reason (~30) ≈ 45 tokens/row — plus headroom for the JSON envelope and the
 * residual reasoning of low-effort/minimal-thinking models (their thinking counts against the limit).
 * Typical rows (target/informational) are ~8–12 tokens, so the limit is rarely approached.
 */
export const RELEVANCE_OUTPUT_TOKENS_PER_ROW = 45
export const RELEVANCE_OUTPUT_TOKENS_OVERHEAD = 1000
/** The Router's own default; a retry after an unusable answer may widen the limit up to it. */
export const RELEVANCE_OUTPUT_TOKENS_CAP = 12000

/** Output token limit for a batch of `rows` unique queries; `attempt` 0 = first call, 1 = retry (doubled, capped). */
export function relevanceMaxOutputTokens(rows: number, attempt = 0): number {
  const base = rows * RELEVANCE_OUTPUT_TOKENS_PER_ROW + RELEVANCE_OUTPUT_TOKENS_OVERHEAD
  return Math.min(RELEVANCE_OUTPUT_TOKENS_CAP, attempt > 0 ? base * 2 : base)
}
/** Cap on the keyword list of one prompt. */
export const RELEVANCE_BATCH_MAX_CHARS = 12000
/** Pages listed in the project context, and chars kept per page field. */
export const RELEVANCE_CONTEXT_PAGES = 40
export const RELEVANCE_CONTEXT_FIELD_CHARS = 140
export const RELEVANCE_REASON_MAX_CHARS = 160
export const RELEVANCE_CONCURRENCY = 3

export type RelevanceDecision = {
  status: RelevanceStatus
  confidence: number
  reason: string
  downgraded: boolean
  /** Saved as 'uncertain' only because the project has no page data to judge against (see `decide`). */
  held: boolean
  /** A geo_mismatch the AI could not back up (place inside the target region, or no region named) — saved as 'uncertain'. */
  geoRejected: boolean
}

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

/** What the AI can actually know about the project: whether it knows the business, and whether it knows the region. */
export type ContextCaps = { business: boolean; region: boolean }

const GENERIC_REGION_WORDS = new Set([
  'область', 'обл', 'край', 'республика', 'респ', 'округ', 'район', 'город', 'федеральный', 'автономный', 'и', 'г', 'в',
  'region', 'oblast', 'state', 'county', 'province', 'district', 'city', 'and', 'the', 'of', 'metro', 'area',
])

/** Crude region fingerprint: 4-letter prefixes of the meaningful words («Москва» and «Московская область» both give «моск»). */
function regionStems(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/ё/g, 'е')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !GENERIC_REGION_WORDS.has(w))
      .map((w) => w.slice(0, 4)),
  )
}

/**
 * True when the region the AI says a place belongs to is (a part of) the target region, e.g. place
 * region «Московская область» vs target «Москва и Московская область». Deliberately generous: a false
 * "overlap" only turns a geo_mismatch into 'uncertain', never the other way round.
 */
export function regionsOverlap(placeRegion: string, targetRegion: string): boolean {
  const place = regionStems(placeRegion)
  for (const stem of regionStems(targetRegion)) if (place.has(stem)) return true
  return false
}

const NO_BUSINESS_REASON = 'Нет данных о проекте (заполните SEO-контекст или загрузите страницы) — решите вручную'
const NO_REGION_REASON = 'Регион проекта не задан (заполните SEO-контекст или загрузите страницы) — решите вручную'

/**
 * Turns one validated AI answer into what is saved (threshold applied, reason cleaned).
 * An exclusion is only saved when the AI could know what it is excluding against: `irrelevant`
 * needs a known business (SEO context or page data), `geo_mismatch` needs a known region. Otherwise
 * it becomes 'uncertain' whatever confidence the AI claims. A boolean `caps` means both at once.
 */
export function decide(
  status: RelevanceStatus,
  confidence: number,
  rawReason: unknown,
  caps: ContextCaps | boolean = true,
  geo?: { queryRegion: string; targetRegion: string },
): RelevanceDecision {
  const known = typeof caps === 'boolean' ? { business: caps, region: caps } : caps
  if (status === 'irrelevant' && !known.business) {
    return { status: 'uncertain', confidence, reason: NO_BUSINESS_REASON, downgraded: false, held: true, geoRejected: false }
  }
  if (status === 'geo_mismatch' && !known.region) {
    return { status: 'uncertain', confidence, reason: NO_REGION_REASON, downgraded: false, held: true, geoRejected: false }
  }
  // With an explicit target region a geo_mismatch must name the region the place belongs to, and that
  // region must not be (part of) the target one — a settlement of the target oblast is never "another region".
  if (status === 'geo_mismatch' && geo?.targetRegion) {
    if (!geo.queryRegion) {
      return { status: 'uncertain', confidence, reason: 'Не указано, к какому региону относится место из запроса — решите вручную', downgraded: false, held: false, geoRejected: true }
    }
    if (regionsOverlap(geo.queryRegion, geo.targetRegion)) {
      return {
        status: 'uncertain',
        confidence,
        reason: cleanReason(`Место из запроса относится к целевому региону (${geo.queryRegion}) — оцените по остальному смыслу запроса`, 'uncertain'),
        downgraded: false,
        held: false,
        geoRejected: true,
      }
    }
  }
  const applied = applyConfidenceThreshold(status, confidence)
  if (!applied.downgraded) return { status, confidence, reason: cleanReason(rawReason, status), downgraded: false, held: false, geoRejected: false }
  const original = cleanReason(rawReason, status)
  return {
    status: 'uncertain',
    confidence,
    reason: cleanReason(`Низкая уверенность AI (${confidence}%): ${original}`, 'uncertain'),
    downgraded: true,
    held: false,
    geoRejected: false,
  }
}

/** One-letter codes of the compact answer. */
const COMPACT_STATUS: Record<string, RelevanceStatus> = { t: 'target', i: 'informational', u: 'uncertain', g: 'geo_mismatch', x: 'irrelevant' }

export type AiRelevanceItem = { keywordId: number; status: RelevanceStatus; confidence: number; reason: string; queryRegion: string }

function stripToJson(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  return t.trim()
}

/**
 * Validates one AI answer. Returns null when the answer as a whole is unusable (not JSON, neither a
 * compact `r` nor a legacy `results` array, or not a single valid item) — the caller then fails that
 * batch and saves nothing. Single bad items (malformed row, unknown id/status, no numeric confidence,
 * repeated id) are dropped; their keywords simply stay unclassified (reported as `unresolved`), never
 * guessed. The AI can never change a query: only ids that were sent are accepted.
 *
 * Compact form (what the prompt asks for): {"r":[[id,"t",92], [id,"u",55,"reason"], [id,"g",90,"region","reason"]]}
 * — t/i carry no reason (the server uses its default), u/x a reason, g the place's region and optionally a reason.
 * The older object form {"results":[{keyword_id,relevance_status,confidence,reason,query_region}]} is still accepted.
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
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const seen = new Set<number>()
  const items: AiRelevanceItem[] = []
  const add = (id: number, status: string, confidence: number, reason: unknown, region: unknown) => {
    if (!Number.isInteger(id) || !sentIds.has(id) || seen.has(id)) return
    if (!isRelevanceStatus(status) || !Number.isFinite(confidence)) return
    seen.add(id)
    items.push({
      keywordId: id,
      status,
      confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      reason: typeof reason === 'string' ? reason : '',
      queryRegion: typeof region === 'string' ? region.replace(/\s+/g, ' ').trim().slice(0, 80) : '',
    })
  }

  if (Array.isArray(root.r)) {
    for (const row of root.r) {
      if (!Array.isArray(row) || row.length < 3) continue
      const code = typeof row[1] === 'string' ? row[1].trim().toLowerCase() : ''
      const status = COMPACT_STATUS[code] ?? code
      const isGeo = status === 'geo_mismatch'
      const region = isGeo ? row[3] : ''
      const reason = isGeo ? row[4] : row[3]
      add(Number(row[0]), status, typeof row[2] === 'number' ? row[2] : Number(row[2]), isGeo && typeof reason !== 'string' && typeof region === 'string' && region.trim() ? `Указан другой регион: ${region.trim()}` : reason, region)
    }
    return items.length ? items : null
  }
  if (!Array.isArray(root.results)) return null
  for (const entry of root.results) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    add(
      Number(e.keyword_id),
      typeof e.relevance_status === 'string' ? e.relevance_status.trim().toLowerCase() : '',
      typeof e.confidence === 'number' ? e.confidence : Number(e.confidence),
      e.reason,
      e.query_region,
    )
  }
  return items.length ? items : null
}

export const RELEVANCE_SYSTEM_PROMPT = `You classify Wordstat search queries by how relevant they are to ONE specific business website.

You get the business context and a list of queries. The context has an explicit SEO CONTEXT written by the owner (business type, target region, main services, planned directions, what is NOT offered) — it is authoritative — plus the project name/domain and compact data of its existing pages (url, title, h1, description) as additional facts. Judge each query by its MEANING relative to what this business actually offers and where it works — never in a vacuum, never by shared words alone. Take the business, its services/products and its region from the given context; do not assume facts that are not there.

relevance_status — exactly one of:
- "target": the query is about a service/product the business offers (including a specific model, brand, car/object type, price, cost, "near me"-style commercial wording). Someone searching it could become a client.
- "informational": about the business topic but the searcher wants to learn (how, which is better, what is, instructions, reviews/comparisons), not to order. This includes questions about which materials, chemicals, pastes, pads/wheels, tools or equipment are needed or how to choose them for the business's OWN service (e.g. «какая химия нужна для химчистки салона», «какую пасту взять для полировки фар», «какие круги нужны для полировки», «какая машинка нужна для полировки авто») — that is content on the project's topic even if the project does not sell those goods.
- "uncertain": potentially relevant but you cannot tell from the context, or the business must decide — e.g. a segment the site does not clearly serve (commercial/special vehicles, taxi, fleets), an intent to BUY the material/goods themselves (not a how-to-choose question) when the site only provides a service, ambiguous wording.
- "geo_mismatch": about the business's service but tied to a place that lies OUTSIDE the target region. The TARGET REGION in the context may be a city, a metro area or a whole oblast/krai/republic/state: EVERY settlement inside it — the towns and cities of the oblast/krai/republic/state named there, not only the city that is named — is part of the target geography and must NEVER get "geo_mismatch". Use "geo_mismatch" only when you are confident that the place in the query lies outside the target region (another region or country), and then also fill "query_region" with the region/country that place belongs to. If you are not sure which region a place belongs to, or whether it is inside the target region, do NOT use "geo_mismatch": classify the query by its remaining intent (usually "target"), or use "uncertain". If the context does not state where the business works, a city or region in a query is NEVER a reason for "geo_mismatch": classify the query as if the place were not there, or use "uncertain".
- "irrelevant": has nothing to do with this business (other topics, other industries, unrelated products). A how-to / which-to-choose question about materials, tools or equipment for the business's own service is NOT irrelevant — it is "informational".

Rules:
0. Use the SEO context literally: MAIN SERVICES and PLANNED / ADDITIONAL DIRECTIONS are part of the business (planned ones count even when no page exists) → "target" (or "informational" for how-to/choice queries); a query whose intent is to BUY / order / rent / sell something in NOT OFFERED (the goods, equipment, tools or materials themselves, for doing it yourself) → "irrelevant", with high confidence. NOT OFFERED only says the project does not SELL or do that; it does not make the topic off-limits: an informational query about which such item to choose, what is needed or how to use it for the project's own services stays "informational" (never "irrelevant" just because the item is listed in NOT OFFERED). The TARGET REGION, its cities and every settlement inside it are never a mismatch; a query without any place has no geographic problem.
1. Do not be aggressive. Being a "similar" query from Wordstat does NOT make a query irrelevant, and a popular one is not automatically a target. When in doubt prefer "uncertain" over "irrelevant"/"geo_mismatch". Missing information about the business is never evidence against a query.
2. Never change, correct or translate a query; you only return its keyword_id.
3. "confidence" is an integer 0-100: how sure you are of THIS status.
4. A "reason" is ONE short sentence in RUSSIAN (at most 12 words) that a business owner can read, e.g. «Запрос не относится к бизнесу проекта», «Нужно решение: сегмент не подтверждён». No reasoning chains, no quotes of the query. Give a reason ONLY where the output format below asks for one.
5. Return a row for EVERY keyword_id you were given, each exactly once. Do not repeat the query text.
6. Return ONLY strict JSON, no markdown, no commentary, in this compact form — one array row per query:
{"r":[[keyword_id,"t",confidence],[keyword_id,"u",confidence,"reason"],[keyword_id,"g",confidence,"query_region","reason"]]}
   The second element is a one-letter status code: "t" = target, "i" = informational, "u" = uncertain, "g" = geo_mismatch, "x" = irrelevant.
   - "t" and "i": exactly [keyword_id,code,confidence] — NO reason.
   - "u" and "x": [keyword_id,code,confidence,"reason"].
   - "g": [keyword_id,"g",confidence,"query_region","reason"] — "query_region" is the short official name of the region/country the place named in the query belongs to (required).`

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

/** Explicit, human-written SEO context of a project (stored in project_seo_context). List fields: one item per line. */
export type SeoContext = {
  businessType: string
  region: string
  services: string
  plannedServices: string
  excluded: string
}

export const EMPTY_SEO_CONTEXT: SeoContext = { businessType: '', region: '', services: '', plannedServices: '', excluded: '' }

export const SEO_CONTEXT_SINGLE_MAX = 200
export const SEO_CONTEXT_LIST_MAX = 2000
const SEO_CONTEXT_LIST_ITEMS = 40

/** Trims every field and caps its length; unknown input becomes an empty string. */
export function normalizeSeoContext(input: unknown): SeoContext {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r/g, '').trim().slice(0, max) : '')
  return {
    businessType: text(o.businessType, SEO_CONTEXT_SINGLE_MAX).replace(/\s*\n\s*/g, ' '),
    region: text(o.region, SEO_CONTEXT_SINGLE_MAX).replace(/\s*\n\s*/g, ' '),
    services: text(o.services, SEO_CONTEXT_LIST_MAX),
    plannedServices: text(o.plannedServices, SEO_CONTEXT_LIST_MAX),
    excluded: text(o.excluded, SEO_CONTEXT_LIST_MAX),
  }
}

function listItems(text: string): string[] {
  return text
    .split(/\n|;/)
    .map((l) => l.replace(/^[-•*\s]+/, '').trim())
    .filter(Boolean)
    .slice(0, SEO_CONTEXT_LIST_ITEMS)
}

/** The AI knows the business when the context names a business type or services. */
export function seoContextKnowsBusiness(ctx: SeoContext | null): boolean {
  return Boolean(ctx && (ctx.businessType || listItems(ctx.services).length))
}

export function seoContextKnowsRegion(ctx: SeoContext | null): boolean {
  return Boolean(ctx && ctx.region)
}

export function seoContextIsEmpty(ctx: SeoContext | null): boolean {
  return !ctx || !(ctx.businessType || ctx.region || ctx.services || ctx.plannedServices || ctx.excluded)
}

/** Capabilities for `decide`: the explicit context OR page data is enough to know the business / the region. */
export function contextCaps(ctx: SeoContext | null, pages: ContextPage[]): ContextCaps {
  const pagesKnown = contextPageCount(pages) > 0
  return { business: seoContextKnowsBusiness(ctx) || pagesKnown, region: seoContextKnowsRegion(ctx) || pagesKnown }
}

export function seoContextBlock(ctx: SeoContext | null): string {
  const none = '(not specified)'
  const list = (text: string) => {
    const items = listItems(text)
    return items.length ? items.map((i) => `- ${i}`).join('\n') : none
  }
  return `BUSINESS TYPE: ${ctx?.businessType || none}
TARGET REGION: ${ctx?.region || none}
MAIN SERVICES / PRODUCTS (queries about these are "target"):
${list(ctx?.services ?? '')}
PLANNED / ADDITIONAL DIRECTIONS (part of the business even without a page on the site — queries about these are "target"):
${list(ctx?.plannedServices ?? '')}
NOT OFFERED — the business explicitly does NOT sell or do this (a query to buy/order it is "irrelevant"; a how-to-choose / what-is-needed question about it for the business's own services is still "informational"):
${list(ctx?.excluded ?? '')}`
}

/**
 * Compact project context for the AI: the explicit SEO context first (the authoritative source),
 * then project name/domain and a capped list of existing pages as additional facts.
 */
export function buildProjectContext(project: { name: string; domain: string }, pages: ContextPage[], seo: SeoContext | null = null): string {
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
${seoContextBlock(seo)}
PAGES (${lines.length}${pages.length > lines.length ? ` of ${pages.length}` : ''}):
${lines.length ? lines.join('\n') : '(no page data available)'}
(If neither the SEO context nor the pages tell what the business does or where, judge from the project name and domain only and prefer "uncertain".)`
}

/** Pages that actually say something about the business — the AI's only source for services and region. */
export function contextPageCount(pages: ContextPage[]): number {
  return pages.filter((p) => p.title || p.h1 || p.description).length
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
