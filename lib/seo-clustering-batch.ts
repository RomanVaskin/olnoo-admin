// Pure helpers for batched SEO clustering (no DB, no network) — unit-testable with node --test.
// A large keyword set is clustered batch by batch, then the per-batch clusters are merged by
// search intent so one intent never survives as several clusters just because its keywords
// landed in different batches.

export type ClusterIntent = 'commercial' | 'informational' | 'navigational' | 'mixed'

/** Keywords per clustering call. ~250 keywords ≈ 11-12k prompt chars and ≈ 5-7k output tokens. */
export const CLUSTER_BATCH_SIZE = 250
/** Hard cap on the keyword list of one batch prompt (the AI Router accepts up to 90 000). */
export const CLUSTER_BATCH_MAX_CHARS = 20000
/** Cluster summaries per merge call (≈ 150 chars each). */
export const MERGE_CHUNK_SIZE = 120
/** Merge passes, each with a different ordering, so similar clusters meet in at least one chunk. */
export const MERGE_MAX_PASSES = 3

export function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ')
}

const STOP_WORDS = new Set([
  'в', 'во', 'на', 'для', 'и', 'с', 'со', 'по', 'под', 'из', 'от', 'до', 'за', 'к', 'ко', 'о', 'об', 'у', 'а', 'или',
  'как', 'что', 'где', 'это', 'the', 'a', 'an', 'of', 'for', 'in', 'on', 'and', 'to',
])

// Longest first; a crude Russian/English ending strip — enough to equate word forms
// ("оклейка"/"оклейки"/"оклейку", "пленка"/"пленки"), not a full morphological analyser.
const ENDINGS = [
  'иями', 'ями', 'ами', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ией', 'ией', 'ией',
  'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ую', 'юю', 'ов', 'ев', 'ах', 'ях', 'ам', 'ям', 'ом', 'ем', 'ия', 'ие', 'ии',
  'ы', 'и', 'а', 'я', 'о', 'е', 'у', 'ю', 'ь', 'й', 'es', 's',
]

export function stem(word: string): string {
  const w = word.toLowerCase().replace(/ё/g, 'е')
  for (const ending of ENDINGS) {
    if (w.length - ending.length >= 3 && w.endsWith(ending)) return w.slice(0, -ending.length)
  }
  return w
}

function contentStems(text: string): string[] {
  return normalizeQuery(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOP_WORDS.has(t))
    .map(stem)
}

/** Order-insensitive stem signature: "оклейки авто" and "авто оклейка" give the same key. */
export function stemSignature(text: string): string {
  return [...new Set(contentStems(text))].sort().join(' ')
}

/** Stems in their original order — keeps phrases with the same head word adjacent when sorted. */
export function stemSequence(text: string): string {
  return contentStems(text).join(' ')
}

/**
 * Splits keywords into batches of at most `batchSize` keywords and `maxChars` prompt chars.
 * Keywords are sorted by stem sequence first, so near-identical phrases share a batch, and all
 * rows with the same query text (one per Wordstat region) always stay in one batch.
 */
export function planBatches<T extends { id: number; query: string; frequency: number | null }>(
  keywords: T[],
  { batchSize = CLUSTER_BATCH_SIZE, maxChars = CLUSTER_BATCH_MAX_CHARS }: { batchSize?: number; maxChars?: number } = {},
): T[][] {
  const groups = new Map<string, T[]>()
  for (const k of keywords) {
    const key = normalizeQuery(k.query)
    const list = groups.get(key) ?? []
    list.push(k)
    groups.set(key, list)
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => {
    const sa = stemSequence(a)
    const sb = stemSequence(b)
    return sa < sb ? -1 : sa > sb ? 1 : a < b ? -1 : a > b ? 1 : 0
  })

  const batches: T[][] = []
  let current: T[] = []
  let chars = 0
  for (const [, rows] of ordered) {
    const rowChars = rows.reduce((sum, k) => sum + promptLine(k).length + 1, 0)
    if (current.length && (current.length + rows.length > batchSize || chars + rowChars > maxChars)) {
      batches.push(current)
      current = []
      chars = 0
    }
    current.push(...rows)
    chars += rowChars
  }
  if (current.length) batches.push(current)
  return batches
}

export function promptLine(k: { query: string; frequency: number | null }): string {
  return `- ${k.query} (frequency: ${k.frequency ?? 0})`
}

/** One cluster as the merge step sees it. */
export type MergeUnit = {
  uid: string
  name: string
  intent: ClusterIntent
  primaryKeyword: string
  totalFrequency: number
  topKeywords: string[]
  recommendedPageUrl: string | null
  /** A human-reviewed existing cluster: new keywords may join it, it never merges into another. */
  fixed: boolean
}

export function summarizeUnit(u: MergeUnit): string {
  const page = u.recommendedPageUrl ? ` | page: ${u.recommendedPageUrl}` : ''
  return `${u.uid} | ${u.intent} | ${u.name} | main: ${u.primaryKeyword} | freq ${u.totalFrequency} | ${u.topKeywords.join(', ')}${page}${u.fixed ? ' | REVIEWED' : ''}`
}

export type MergeGroup = {
  ids: string[]
  name: string
  primaryKeyword: string
  intent: ClusterIntent
  recommendedPageUrl: string | null
  confidence: number
  needsNewPage: boolean
  excludeFromSeo: boolean
  reason: string
}

export const MERGE_SYSTEM_PROMPT = `You are an SEO strategist consolidating keyword clusters for ONE website.

The clusters below were produced independently from separate batches of the same keyword set, so ONE search intent can appear several times under different wording. Your job: find clusters that represent the SAME search intent — the same thing the searcher wants, answerable by ONE landing page — and group them.

Merge when the difference is only wording: synonyms ("авто" / "автомобиль" / "машина"), word forms, word order, or filler words ("цена", "стоимость", "услуги", "заказать", "купить", "москва" when every cluster is about the same city). Example: "оклейка авто", "оклейка автомобиля" and "оклейка машины" are ONE intent.

Do NOT merge genuinely different intents: a different service or product type (e.g. полиуретановая пленка vs виниловая оклейка vs полировка), a specific car part or zone vs the whole car, informational ("как", "что такое", "своими руками") vs commercial, a different city, or a specific brand. Clusters marked REVIEWED were confirmed by a human: you may add other clusters to a REVIEWED cluster's group, but never put two REVIEWED clusters in the same group.

Return ONLY strict JSON, no markdown:
{
  "groups": [
    {
      "ids": string[],            // 2 or more cluster ids from the list, each id in at most one group
      "name": string,             // name of the merged intent, in the keywords' language
      "primaryKeyword": string,   // the most representative keyword shown for these clusters
      "intent": "commercial" | "informational" | "navigational" | "mixed",
      "recommendedPageUrl": string | null,  // exact url from EXISTING PAGES only if it genuinely matches, else null
      "confidence": number,       // 0-100
      "needsNewPage": boolean,
      "excludeFromSeo": boolean,  // true only for third-party brand/navigational queries
      "reason": string            // one short sentence in the keywords' language
    }
  ]
}
List only groups of 2+ clusters. Clusters that stay on their own must not be listed. If nothing should be merged, return {"groups": []}.`

export function buildMergeUserPrompt(units: MergeUnit[], pagesBlock: string): string {
  return `CLUSTERS (${units.length}):
${units.map(summarizeUnit).join('\n')}

EXISTING PAGES:
${pagesBlock}

Group the clusters that share one search intent and return the JSON described in your instructions.`
}

const INTENTS: ClusterIntent[] = ['commercial', 'informational', 'navigational', 'mixed']

export function stripToJson(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  return t.trim()
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripToJson(raw)
  for (const candidate of [text, text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    try {
      const data = JSON.parse(candidate)
      if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** Parses a merge answer; keeps only known ids, each in at most one group, groups of 2+. Returns null when not JSON. */
export function parseMergeResponse(raw: string, knownIds: Set<string>): MergeGroup[] | null {
  const data = parseJsonObject(raw)
  if (!data || !Array.isArray(data.groups)) return null
  const used = new Set<string>()
  const result: MergeGroup[] = []
  for (const entry of data.groups) {
    if (!entry || typeof entry !== 'object') continue
    const g = entry as Record<string, unknown>
    const ids = (Array.isArray(g.ids) ? g.ids : [])
      .map((id) => String(id).trim())
      .filter((id) => knownIds.has(id) && !used.has(id))
    const unique = [...new Set(ids)]
    if (unique.length < 2) continue
    unique.forEach((id) => used.add(id))
    const intentRaw = typeof g.intent === 'string' ? (g.intent.toLowerCase() as ClusterIntent) : 'mixed'
    const confidence = Number(g.confidence)
    result.push({
      ids: unique,
      name: typeof g.name === 'string' && g.name.trim() ? g.name.trim() : '',
      primaryKeyword: typeof g.primaryKeyword === 'string' ? g.primaryKeyword.trim() : '',
      intent: INTENTS.includes(intentRaw) ? intentRaw : 'mixed',
      recommendedPageUrl: typeof g.recommendedPageUrl === 'string' && g.recommendedPageUrl.trim() ? g.recommendedPageUrl.trim() : null,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, Math.round(confidence))) : 0,
      needsNewPage: typeof g.needsNewPage === 'boolean' ? g.needsNewPage : true,
      excludeFromSeo: g.excludeFromSeo === true,
      reason: typeof g.reason === 'string' ? g.reason.trim() : '',
    })
  }
  return result
}

/** Union-find over unit ids; a set may contain at most one fixed (human-reviewed) unit. */
export class UnitGroups {
  private parent = new Map<string, string>()
  private fixedIn = new Map<string, boolean>()

  constructor(units: { uid: string; fixed: boolean }[]) {
    for (const u of units) {
      this.parent.set(u.uid, u.uid)
      this.fixedIn.set(u.uid, u.fixed)
    }
  }

  find(id: string): string {
    let root = id
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    let cur = id
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!
      this.parent.set(cur, root)
      cur = next
    }
    return root
  }

  /** Joins two sets; refuses (returns false) when both already contain a reviewed cluster. */
  union(a: string, b: string): boolean {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb) return true
    const fa = this.fixedIn.get(ra)!
    const fb = this.fixedIn.get(rb)!
    if (fa && fb) return false
    // The reviewed cluster's set keeps the root, so its identity survives.
    const [root, child] = fb && !fa ? [rb, ra] : [ra, rb]
    this.parent.set(child, root)
    this.fixedIn.set(root, fa || fb)
    return true
  }

  roots(): string[] {
    return [...new Set([...this.parent.keys()].map((id) => this.find(id)))]
  }

  members(): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const id of this.parent.keys()) {
      const root = this.find(id)
      const list = map.get(root) ?? []
      list.push(id)
      map.set(root, list)
    }
    return map
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Orderings for successive merge passes. */
export const MERGE_ORDERINGS: ((u: MergeUnit) => string)[] = [
  (u) => `${stemSequence(u.primaryKeyword)}|${u.uid}`,
  (u) => `${stemSignature(u.primaryKeyword)}|${u.uid}`,
  (u) => `${u.intent}|${stemSignature(u.name)}|${u.uid}`,
]
