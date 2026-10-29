import type { Pool } from 'pg'
import { callAiRouter } from './ai-router.ts'
import { buildProjectAiContext, projectAiContextBlock } from './project-ai-context.ts'

// Контент-завод — turns one source item's original text into an independent article for the
// project's own channel. Pool-injected, no `@/` imports — directly testable under this project's
// plain `node --test`, same convention as lib/social-quality-gate.ts. ONE callAiRouter call per
// generation, reusing the exact same project AI context (Brand Profile + verified SEO context)
// every other AI touch point in this codebase already uses — so AURELMAR's "professional,
// international, analytical, no hype" voice is just that project's own Brand Profile, set once via
// the existing Projects screen, never hardcoded here.

export class ContentFactoryGenerateError extends Error {}

export type GeneratedContent = {
  title: string
  body: string
  needsReview: boolean
  reviewReason: string
}

const TITLE_MAX = 200
const BODY_MAX = 4000
const REASON_MAX = 500

// Rule 6 is the task's own explicit requirement: a claim about price, yield/profitability,
// legislation, or investment that cannot be confirmed from TEXT/PROJECT CONTEXT must never be
// published as a verified fact — it goes to manual review instead. Rule 2 is the equally explicit
// "do not simply repost" requirement — this is a rewrite from extracted facts, not a copy or a
// light paraphrase. Rule 8 (no source images) mirrors the task's "Не использовать чужие
// изображения без разрешения" restriction — this file never even sees image data; the Content
// Factory as a whole simply doesn't propose using them.
export const CONTENT_FACTORY_SYSTEM_PROMPT = `You are a content editor for the project described in PROJECT CONTEXT below, turning ONE source publication (from a partner/industry channel, given as SOURCE TEXT and SOURCE URL) into an independent, original article for this project's own channel.

Hard rules:
1. Extract the actual facts from SOURCE TEXT first, then write a genuinely new, independent article from those facts — never a repost, translation, or light paraphrase of SOURCE TEXT. The wording, structure, and opening must be your own.
2. Write a new, independent "title" — never SOURCE TEXT's own headline reused or lightly reworded.
3. Remove anything that is the SOURCE channel's own advertising, self-promotion, or call to action — none of that belongs in the result.
4. Cite the source: mention where the information comes from and include SOURCE URL itself, in the project's own voice (e.g. "по данным..." / "according to...", or an equivalent natural phrasing in the target language) — never presented as this project's own original research.
5. You may add a short, unobtrusive call to action toward the project described in PROJECT CONTEXT (e.g. an invitation to get in touch) only if PROJECT CONTEXT's Brand Profile makes one appropriate — never aggressive sales language, never forced in.
6. If SOURCE TEXT contains a claim about PRICE, YIELD/PROFITABILITY, LEGISLATION, or an INVESTMENT recommendation that PROJECT CONTEXT does not itself confirm, do NOT present it as a verified fact — phrase it as reported/unconfirmed information (e.g. "по данным источника..., требует уточнения") AND set "needsReview": true with a specific "reviewReason" naming which claim needs checking. Do this for every such claim you cannot confirm, even if the rest of the article is fine.
7. Never invent a fact, number, price, law, or claim that isn't present in SOURCE TEXT or PROJECT CONTEXT.
8. Do not propose, describe, or reference reusing any image from the source — this project's own visuals are handled separately, outside of what you write.
9. Match PROJECT CONTEXT's Brand Profile (tone & style, constraints) exactly; write in the language PROJECT CONTEXT asks for, or if none is specified, the same language as SOURCE TEXT.
10. Return ONLY a strict JSON object — no markdown, no code fences, no commentary before or after. Shape: {"title": string, "body": string, "needsReview": boolean, "reviewReason": string}. "reviewReason" is "" when needsReview is false. The raw response is parsed as JSON directly.`

export function buildContentFactoryPrompt(input: { sourceText: string; sourceUrl: string; contextBlock: string }): string {
  return `PROJECT CONTEXT:
${input.contextBlock}

SOURCE URL: ${input.sourceUrl || '(no URL available)'}

SOURCE TEXT:
${input.sourceText}

Write the independent article as the JSON object described in the system rules, nothing else.`
}

function stripToJson(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  return t.trim()
}

function clip(text: string, max: number): string {
  return text.trim().slice(0, max)
}

/** Normalizes whitespace/case so a verbatim-copy check isn't defeated by trivial formatting
 * differences (extra spaces, line breaks, capitalization) between SOURCE TEXT and the result. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

// Deterministic guard, not just a prompt rule (same posture as lib/social-content-quality.ts's
// looksLikeMetaDescription) — rule 1 above is a request, not a guarantee. A long verbatim run
// shared between the generated body and the original source text means the model repeated/lightly
// reworded the source rather than writing an independent piece, regardless of what it otherwise
// claims; MIN_RUN is long enough that it won't trip on a short common phrase or a deliberately
// quoted figure.
const MIN_VERBATIM_RUN = 60

export function hasVerbatimOverlap(generated: string, original: string, minRun: number = MIN_VERBATIM_RUN): boolean {
  const g = normalize(generated)
  const o = normalize(original)
  if (g.length < minRun || o.length < minRun) return false
  for (let i = 0; i + minRun <= g.length; i += Math.max(1, Math.floor(minRun / 2))) {
    if (o.includes(g.slice(i, i + minRun))) return true
  }
  return false
}

/**
 * Parses the AI Router's generation response. Throws `ContentFactoryGenerateError` (never a raw
 * parse exception) if the response is unusable; a usable title+body always produces a result —
 * `needsReview`/`reviewReason` are adjusted (never silently loosened) by the two independent
 * guards below rather than the model's own claim being trusted outright:
 *
 * - `needsReview` must be a genuine boolean from the model. Any other type (missing, a string, a
 *   number, ...) is treated as `true` (manual review required), never silently coerced to `false`
 *   — the same lesson as the Quality Gate fix (a human must look at an item the model's own
 *   signal about could not be trusted), just applied in the direction that is safe for THIS
 *   deliverable: dropping the whole generation isn't an option (there is still a result to show),
 *   so an untrustworthy signal defaults to the cautious outcome instead.
 * - A verbatim-overlap hit with the source text forces `needsReview: true` regardless of what the
 *   model reported, with its own reviewReason — see `hasVerbatimOverlap`.
 */
export function parseGenerationResult(raw: string, originalText: string, sourceUrl: string): GeneratedContent {
  const text = stripToJson(raw)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new ContentFactoryGenerateError('AI Router returned a response that is not a valid JSON object.')
    }
    try {
      data = JSON.parse(text.slice(start, end + 1))
    } catch {
      throw new ContentFactoryGenerateError('AI Router returned a response that is not a valid JSON object.')
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ContentFactoryGenerateError('AI Router did not return a JSON object.')
  }
  const obj = data as Record<string, unknown>
  const title = typeof obj.title === 'string' ? clip(obj.title, TITLE_MAX) : ''
  let body = typeof obj.body === 'string' ? clip(obj.body, BODY_MAX) : ''
  if (!title || !body) {
    throw new ContentFactoryGenerateError('AI Router did not return a usable title and body.')
  }

  let needsReview = typeof obj.needsReview === 'boolean' ? obj.needsReview : true
  let reviewReason = typeof obj.reviewReason === 'string' ? clip(obj.reviewReason, REASON_MAX) : ''
  if (typeof obj.needsReview !== 'boolean') {
    reviewReason = reviewReason || 'The model\'s "needs review" flag was not a valid boolean — defaulting to manual review required.'
  }

  if (hasVerbatimOverlap(body, originalText)) {
    needsReview = true
    reviewReason = 'The generated text closely matches the source text verbatim — review before publishing.'
  }

  // Deterministic safety net for the task's own "добавлять ссылку на источник" requirement —
  // never left purely to the model's own compliance with rule 4.
  if (sourceUrl && !body.includes(sourceUrl)) {
    body = clip(`${body}\n\nИсточник: ${sourceUrl}`, BODY_MAX)
  }

  return { title, body, needsReview, reviewReason }
}

export type GenerateContentFactoryItemInput = {
  sourceText: string
  sourceUrl: string
}

/**
 * Runs one generation for one item — a single AI Router call, no new service. Throws
 * `ContentFactoryGenerateError`/`AiRouterError` on any failure (empty source text, AI Router
 * error, unusable response); the caller (the API route) is responsible for recording that as the
 * item's own 'failed' status rather than losing the item's original text, exactly like every
 * other AI call in this codebase treats its own failures.
 */
export async function generateContentFactoryArticle(pool: Pool, projectId: number, input: GenerateContentFactoryItemInput): Promise<GeneratedContent> {
  const sourceText = input.sourceText.trim()
  if (!sourceText) throw new ContentFactoryGenerateError('There is no source text to work from.')

  const contextBlock = projectAiContextBlock(await buildProjectAiContext(pool, projectId))

  const content = await callAiRouter(
    [
      { role: 'system', content: CONTENT_FACTORY_SYSTEM_PROMPT },
      { role: 'user', content: buildContentFactoryPrompt({ sourceText, sourceUrl: input.sourceUrl, contextBlock }) },
    ],
    { temperature: 0.4, task: 'content-factory-generate' },
  )

  return parseGenerationResult(content, sourceText, input.sourceUrl)
}
