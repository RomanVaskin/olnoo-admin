// OLNOO Social AI Agent MVP — pure planning-prompt construction and response parsing. Zero `@/`
// imports, directly testable under this project's plain `node --test` (same reasoning as
// lib/social-telegram-comments.ts). The actual AI Router call (lib/ai-router.ts's `callAiRouter`,
// itself `@/`-free) lives in lib/social-agent.ts; this file only decides what to ask for and makes
// sense of the JSON that comes back.

export type SocialAgentPlanItem = { topic: string; body: string; channels: string[] }

export class SocialAgentPlanError extends Error {}

// A runaway/huge AI response is capped rather than trusted outright — same defensive posture
// lib/social-ai.ts's parseVariants already uses (only requested channel keys are kept, never
// whatever extra the model adds).
const MAX_PLAN_ITEMS = 10

export const SOCIAL_AGENT_PLAN_SYSTEM_PROMPT = `You are a social media content planner for OLNOO, turning ONE free-text task written by a project's own admin into a short posting plan.

Hard rules:
1. Decide how many posts the task calls for from its own wording (e.g. "three posts" -> 3 posts); if the task doesn't say, plan exactly 3 posts.
2. Each post gets its own distinct topic and a short, factual body (shared content every channel later adapts from) — never invent clients, prices, numbers, results, or promises not implied by TASK or PROJECT CONTEXT.
3. "channels" for each post must be chosen ONLY from AVAILABLE CHANNELS — never invent or assume a channel the project hasn't connected. If AVAILABLE CHANNELS is empty, still produce the plan, with an empty "channels" array for each post.
4. Write every topic and body in the SAME language as TASK itself — detect it from TASK's own text, never translate, never switch languages regardless of what language PROJECT CONTEXT happens to be in.
5. Return ONLY a strict JSON array — no markdown, no code fences, no commentary before or after. Each array element is an object with exactly "topic", "body", "channels" (an array of strings). The raw response is parsed as JSON directly.`

export function buildSocialAgentPlanPrompt(input: { task: string; projectContext: string; availableChannels: string[] }): string {
  return `TASK: ${input.task}

PROJECT CONTEXT: ${input.projectContext || '(none given)'}

AVAILABLE CHANNELS: ${input.availableChannels.length ? input.availableChannels.join(', ') : '(none connected)'}

Produce the posting plan as a JSON array, following the system rules exactly.`
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
    items.push({ topic, body, channels })
    if (items.length >= MAX_PLAN_ITEMS) break
  }

  if (items.length === 0) {
    throw new SocialAgentPlanError('AI Router did not return any usable posts for this task (check that the project has a connected channel).')
  }
  return items
}
