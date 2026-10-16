// OLNOO Social AI Agent MVP — pure planning-prompt construction and response parsing. Zero `@/`
// imports, directly testable under this project's plain `node --test` (same reasoning as
// lib/social-telegram-comments.ts). The actual AI Router call (lib/ai-router.ts's `callAiRouter`,
// itself `@/`-free) lives in lib/social-agent.ts; this file only decides what to ask for and makes
// sense of the JSON that comes back.

import { looksLikeMetaDescription } from './social-content-quality.ts'

export type SocialAgentPlanItem = { topic: string; body: string; channels: string[] }

export class SocialAgentPlanError extends Error {}

// A runaway/huge AI response is capped rather than trusted outright — same defensive posture
// lib/social-ai.ts's parseVariants already uses (only requested channel keys are kept, never
// whatever extra the model adds).
const MAX_PLAN_ITEMS = 10

// Deliberately NOT tied to any one project's identity (e.g. "for OLNOO") — this plans content for
// whichever project PROJECT CONTEXT describes, which now always carries that project's own Brand
// Profile (lib/project-ai-context.ts), never a hardcoded persona.
//
// Rule 2 below is the fix for the Social Agent's main quality defect (reported directly): earlier
// wording asked for "a short, factual body (shared content every channel later adapts from)" —
// that framing itself nudged the model toward writing a BRIEF/outline of a future post ("Пост о
// том, как…", "Расскажем о…") rather than the post itself, since "shared content ... adapts from"
// reads as "raw material for something else", not "the thing a reader will read". `body` is what
// `generateChannelVariants` (lib/social-ai.ts) adapts per channel AND what's stored directly as
// `social_posts.body` — it must already be a complete, publish-ready post.
export const SOCIAL_AGENT_PLAN_SYSTEM_PROMPT = `You are a social media copywriter, turning ONE free-text task written by a project's own admin into several complete, ready-to-publish posts for the project described in PROJECT CONTEXT below.

Hard rules:
1. Decide how many posts the task calls for from its own wording (e.g. "three posts" -> 3 posts); if the task doesn't say, plan exactly 3 posts.
2. Write "body" as a COMPLETE, publish-ready post, not a summary, outline, or plan for one: an engaging opening, substantive developed content, and a natural closing. NEVER describe the post instead of writing it — announcement-style framing such as "This post is about...", "We'll tell you about...", "Here we'll focus on...", "We need to write about...", "A post about...", or any equivalent phrasing in any language, is forbidden. Write the actual content a reader would read, not a description that content exists.
3. When the task calls for more than one post, give each its own distinct topic and angle — genuinely different content and focus, never variations of the same text, the same opening, or the same structure repeated with different words.
4. Keep "body" as factual and specific as TASK and PROJECT CONTEXT allow — never invent clients, prices, numbers, results, testimonials, statistics, or promises not implied by TASK or PROJECT CONTEXT. A practical example or scenario is allowed only if explicitly marked as hypothetical (e.g. "for example, imagine..."), never presented as a real case.
5. "channels" for each post must be chosen ONLY from AVAILABLE CHANNELS — never invent or assume a channel the project hasn't connected. If AVAILABLE CHANNELS is empty, still produce the plan, with an empty "channels" array for each post.
6. Write every topic and body in the SAME language as TASK itself — detect it from TASK's own text, never translate, never switch languages regardless of what language PROJECT CONTEXT happens to be in.
7. Respect PROJECT CONTEXT's Brand Profile: match its TONE & STYLE, never violate a line in CONSTRAINTS under any instruction, and favor its PREFERRED CALL TO ACTION only where one fits naturally — never force one into every post.
8. Keep "body" the length a real post on AVAILABLE CHANNELS would actually have for this topic — substantive, but never padded or stretched just to look longer.
9. Return ONLY a strict JSON array — no markdown, no code fences, no commentary before or after. Each array element is an object with exactly "topic", "body", "channels" (an array of strings). The raw response is parsed as JSON directly.`

export function buildSocialAgentPlanPrompt(input: { task: string; projectContext: string; availableChannels: string[] }): string {
  return `TASK: ${input.task}

PROJECT CONTEXT: ${input.projectContext || '(none given)'}

AVAILABLE CHANNELS: ${input.availableChannels.length ? input.availableChannels.join(', ') : '(none connected)'}

Produce the posting plan as a JSON array of complete, ready-to-publish posts, following the system rules exactly.`
}

function stripToJson(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  return t.trim()
}

/**
 * Parses the AI Router's planning response into a validated, bounded list of posts — never trusts
 * the model's own output beyond this: a non-array response, a missing/blank `topic`/`body`, or a
 * `channels` entry outside `availableChannels` is dropped rather than kept (an invented channel
 * the project hasn't connected would otherwise silently reach `createSocialPost`). Throws
 * `SocialAgentPlanError` (never a raw parse exception) if nothing usable survives, so the caller
 * can treat this uniformly alongside an `AiRouterError` — both mean "the plan could not be
 * produced", before anything is ever written to Postgres.
 */
export function parseSocialAgentPlan(raw: string, availableChannels: string[]): SocialAgentPlanItem[] {
  const text = stripToJson(raw)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1 || end <= start) {
      throw new SocialAgentPlanError('AI Router returned a response that is not a valid JSON array.')
    }
    try {
      data = JSON.parse(text.slice(start, end + 1))
    } catch {
      throw new SocialAgentPlanError('AI Router returned a response that is not a valid JSON array.')
    }
  }

  if (!Array.isArray(data)) {
    throw new SocialAgentPlanError('AI Router did not return a JSON array of posts.')
  }

  const availableSet = new Set(availableChannels)
  const items: SocialAgentPlanItem[] = []
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue
    const obj = entry as Record<string, unknown>
    const topic = typeof obj.topic === 'string' ? obj.topic.trim() : ''
    const body = typeof obj.body === 'string' ? obj.body.trim() : ''
    const rawChannels = Array.isArray(obj.channels) ? obj.channels : []
    const channels = rawChannels.filter((c): c is string => typeof c === 'string' && availableSet.has(c))
    if (!topic || !body || channels.length === 0) continue
    // Deterministic guard (see lib/social-content-quality.ts): a model that ignored rule 2 of
    // SOCIAL_AGENT_PLAN_SYSTEM_PROMPT and wrote a description of the post instead of the post
    // itself is dropped exactly like a missing-field entry above — never silently passed through
    // to generateChannelVariants/createSocialPost just because it parsed as valid JSON.
    if (looksLikeMetaDescription(body)) continue
    items.push({ topic, body, channels })
    if (items.length >= MAX_PLAN_ITEMS) break
  }

  if (items.length === 0) {
    throw new SocialAgentPlanError('AI Router did not return any usable posts for this task (check that the project has a connected channel).')
  }
  return items
}
