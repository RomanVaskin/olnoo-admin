import type { Pool } from 'pg'
import { callAiRouter } from './ai-router.ts'
import { buildProjectAiContext, projectAiContextBlock } from './project-ai-context.ts'

// OLNOO Social AI Agent 2.0 — Quality Gate for one post's Content, inside the existing post card
// (no new agent/app/service). One AI Router call reviews TEXT against a fixed set of criteria and
// returns a bounded, validated set of findings; it never writes to social_posts, never blocks
// status transitions, and never auto-applies anything — the existing AI Editor
// (lib/social-ai-editor.ts) is reused to propose a fix, with its own existing
// compare/Apply/Cancel mechanism, when the admin asks for one.
//
// No `@/` imports (pool injected, same convention as lib/social-agent.ts/lib/social-ai-editor.ts)
// — directly testable under this project's plain `node --test`.

export class QualityGateError extends Error {}

// Fixed, not project-configurable — an MVP constraint, not a limitation of the AI Router call
// itself. Order here is only documentation; findings are returned in whatever order the model
// ranks them by severity, capped at MAX_FINDINGS.
export const QUALITY_CATEGORIES = [
  'specificity', // конкретность и практическая польза
  'factuality', // достоверность утверждений относительно доступного контекста
  'brand_profile', // соответствие Brand Profile
  'structure', // структура и читаемость
  'repetition_cliches', // повторы и ИИ-штампы
  'platform_fit', // соответствие выбранной платформе
  'cta', // уместность CTA
] as const
export type QualityCategory = (typeof QUALITY_CATEGORIES)[number]

function isQualityCategory(value: unknown): value is QualityCategory {
  return typeof value === 'string' && (QUALITY_CATEGORIES as readonly string[]).includes(value)
}

export type QualityFinding = {
  category: QualityCategory
  excerpt: string
  explanation: string
  recommendation: string
  /** True when the finding is about a claim the model could not verify against PROJECT CONTEXT —
   * never set for a claim the model is asserting is actually false. See rule 2 below: absence of a
   * fact from context is not evidence it is false. */
  needsVerification: boolean
}

export type QualityGateResult = {
  summary: string
  findings: QualityFinding[]
}

// A runaway response is capped rather than trusted outright — same defensive posture
// lib/social-agent-plan.ts's MAX_PLAN_ITEMS and lib/social-ai.ts's parseVariants already use.
const MAX_FINDINGS = 5
const SUMMARY_MAX = 400
const EXCERPT_MAX = 300
const EXPLANATION_MAX = 500
const RECOMMENDATION_MAX = 500

// Deliberately NOT tied to OLNOO or to any one project's persona — see lib/social-ai-editor.ts's
// own comment for the same reasoning. The seven criteria are the task's own list, in the task's
// own order.
export const QUALITY_GATE_SYSTEM_PROMPT = `You are a quality reviewer for one social media post belonging to the project described in PROJECT CONTEXT below. Review TEXT, intended for the platform(s) listed in PLATFORMS, against these criteria:
1. Specificity and practical usefulness — is it concrete and useful, or vague filler?
2. Factual reliability relative to PROJECT CONTEXT — does it claim something PROJECT CONTEXT contradicts, or something neither TEXT nor PROJECT CONTEXT supports?
3. Fit with PROJECT CONTEXT's Brand Profile — tone & style, constraints, preferred CTA.
4. Structure and readability.
5. Repetition and generic AI-sounding clichés.
6. Fit for the selected PLATFORMS (length, tone, conventions for that platform).
7. Whether its call to action, if any, is appropriate — a post is NOT required to have a CTA; a post with no CTA is never itself a finding.

Hard rules:
1. Return at most 5 findings, ranked by severity (most important first). A post with no real issues returns an empty findings array and a short positive summary — never invent filler findings to fill the list.
2. Never claim a statement is FALSE merely because it is absent from PROJECT CONTEXT — PROJECT CONTEXT is not exhaustive. If TEXT claims something PROJECT CONTEXT neither confirms nor denies, set "needsVerification": true and phrase the finding as something to confirm, never as a false claim already disproven.
3. Every finding must quote a short, real, verbatim excerpt from TEXT in "excerpt" — never a paraphrase, never a fabricated quote.
4. Each finding needs a specific, actionable "recommendation" — not a generic instruction to "improve the text".
5. Return ONLY a strict JSON object — no markdown, no code fences, no commentary before or after. Shape: {"summary": string, "findings": [{"category": one of "specificity"|"factuality"|"brand_profile"|"structure"|"repetition_cliches"|"platform_fit"|"cta", "excerpt": string, "explanation": string, "recommendation": string, "needsVerification": boolean}]}. The raw response is parsed as JSON directly.`

export function buildQualityGatePrompt(input: { text: string; channels: string[]; contextBlock: string }): string {
  return `PROJECT CONTEXT:
${input.contextBlock}

PLATFORMS: ${input.channels.length ? input.channels.join(', ') : '(none selected yet)'}

TEXT:
${input.text}

Review TEXT against the system rules and return the JSON object, nothing else.`
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

/**
 * Parses the AI Router's review response into a validated, bounded result — never trusts the
 * model's own output beyond this: a finding with an unknown category, a missing/blank
 * excerpt/explanation/recommendation, or a non-boolean `needsVerification` is dropped entirely
 * (never defaulted/guessed), and every string is length-capped. Throws `QualityGateError` (never a
 * raw parse exception) if the response isn't a usable JSON object at all — an empty-but-valid
 * `findings` array is a legitimate "no issues found" result, not an error.
 */
export function parseQualityGateResult(raw: string): QualityGateResult {
  const text = stripToJson(raw)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new QualityGateError('AI Router returned a response that is not a valid JSON object.')
    }
    try {
      data = JSON.parse(text.slice(start, end + 1))
    } catch {
      throw new QualityGateError('AI Router returned a response that is not a valid JSON object.')
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new QualityGateError('AI Router did not return a JSON object.')
  }
  const obj = data as Record<string, unknown>

  const summary = typeof obj.summary === 'string' ? clip(obj.summary, SUMMARY_MAX) : ''
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : []
  const findings: QualityFinding[] = []
  for (const entry of rawFindings) {
    if (!entry || typeof entry !== 'object') continue
    const f = entry as Record<string, unknown>
    if (!isQualityCategory(f.category)) continue
    const excerpt = typeof f.excerpt === 'string' ? clip(f.excerpt, EXCERPT_MAX) : ''
    const explanation = typeof f.explanation === 'string' ? clip(f.explanation, EXPLANATION_MAX) : ''
    const recommendation = typeof f.recommendation === 'string' ? clip(f.recommendation, RECOMMENDATION_MAX) : ''
    if (!excerpt || !explanation || !recommendation) continue
    const needsVerification = f.needsVerification === true
    findings.push({ category: f.category, excerpt, explanation, recommendation, needsVerification })
    if (findings.length >= MAX_FINDINGS) break
  }

  if (!summary && findings.length === 0) {
    throw new QualityGateError('AI Router did not return a usable quality review.')
  }
  return { summary, findings }
}

export type RunQualityGateInput = {
  text: string
  channels: string[]
}

/**
 * Runs one Quality Gate review for one project's post text — a single AI Router call, no new
 * service/table/queue. Throws `QualityGateError`/`AiRouterError` on any failure (empty input, AI
 * Router error, unusable response) — never a raw/untyped error, so the route's own `catch` can
 * always report a clear cause instead of its generic fallback (and never a raw Postgres error —
 * see the route's own comment). Read-only: never mutates or persists anything; the caller decides
 * whether to act on the findings (e.g. by handing them to the existing AI Editor's `custom`
 * action), and nothing reaches Postgres until the post editor's own "Save" runs.
 */
export async function runQualityGate(pool: Pool, projectId: number, input: RunQualityGateInput): Promise<QualityGateResult> {
  const text = input.text.trim()
  if (!text) throw new QualityGateError('There is no text to check yet.')

  const contextBlock = projectAiContextBlock(await buildProjectAiContext(pool, projectId))

  const content = await callAiRouter(
    [
      { role: 'system', content: QUALITY_GATE_SYSTEM_PROMPT },
      { role: 'user', content: buildQualityGatePrompt({ text, channels: input.channels, contextBlock }) },
    ],
    { temperature: 0.2, task: 'social-quality-gate' },
  )

  return parseQualityGateResult(content)
}
