import type { Pool } from 'pg'
import { callAiRouter } from './ai-router.ts'
import { isSocialChannel, type SocialChannel } from './social.ts'

export class SocialAiError extends Error {}

const CHANNEL_STYLE: Record<SocialChannel, string> = {
  telegram:
    'Telegram: expert, informative tone; may run longer than the other channels; avoid excessive marketing hype or salesy language.',
  instagram:
    'Instagram: shorter than Telegram; written as a caption; break it into short, visually readable paragraphs — no long unbroken block of text.',
  threads: 'Threads: short and natural, conversational; never a long wall of text.',
  vk: 'VK: practical and matter-of-fact; can be more detailed than Threads or Instagram, but never invent facts or metrics not in the source.',
}

const SOCIAL_VARIANTS_SYSTEM_PROMPT = `You are a social media copywriter adapting one piece of source content into platform-specific variants for OLNOO, a technology/automation company.

Per-platform style:
- ${CHANNEL_STYLE.telegram}
- ${CHANNEL_STYLE.instagram}
- ${CHANNEL_STYLE.threads}
- ${CHANNEL_STYLE.vk}

Hard rules:
1. Preserve the meaning of the source Content exactly — do not change what it claims or promises.
2. Never invent clients, companies, or names not present in the source Content or project context.
3. Never invent numbers, statistics, or metrics not present in the source Content or project context.
4. Never invent results or outcomes not present in the source Content or project context.
5. Write every variant in the same language as CONTENT below (its detected language is given as CONTENT LANGUAGE). Never translate into a different language. TOPIC, PROJECT CONTEXT, or any other signal never override this — only an explicit instruction written inside CONTENT itself could, and none is given here.
6. Return ONLY strict JSON — no markdown, no code fences, no commentary before or after. The raw response is parsed as JSON directly.
7. The JSON object must contain exactly the requested channel keys — no more, no fewer. Never include a key for a channel that was not requested.`

function buildUserPrompt(input: {
  topic: string
  body: string
  channels: SocialChannel[]
  contentLanguage: string
  projectContext: string
}): string {
  return `TOPIC: ${input.topic || '(none given)'}

CONTENT:
${input.body}

CONTENT LANGUAGE: ${input.contentLanguage}

PROJECT CONTEXT: ${input.projectContext || '(none given)'}

Generate one adapted variant for each of these channels only: ${input.channels.join(', ')}. Write every variant in CONTENT LANGUAGE — do not translate.

Return JSON with exactly these keys: ${JSON.stringify(input.channels)}.`
}

/** Detects Russian vs English from CONTENT's own characters — never from UI/interface locale.
 * A single Cyrillic letter is a reliable signal the text is Russian; anything else (Latin,
 * digits, punctuation, emoji) defaults to English. TOPIC is deliberately not inspected: the task
 * is explicit that Content is the primary and only signal for output language. */
function detectContentLanguage(body: string): 'ru' | 'en' {
  return /[а-яё]/i.test(body) ? 'ru' : 'en'
}

function stripToJson(text: string): string {
  let t = text.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  return t.trim()
}

/** Keeps only entries for channels that were actually requested, even if the model ignored rule
 * 7 and returned extras — the caller never receives text for a channel it didn't ask for. */
function parseVariants(raw: string, channels: SocialChannel[]): Partial<Record<SocialChannel, string>> {
  const text = stripToJson(raw)
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new SocialAiError('AI Router returned a response that is not valid JSON.')
    }
    try {
      data = JSON.parse(text.slice(start, end + 1))
    } catch {
      throw new SocialAiError('AI Router returned a response that is not valid JSON.')
    }
  }

  if (!data || typeof data !== 'object') {
    throw new SocialAiError('AI Router response is not a JSON object.')
  }

  const obj = data as Record<string, unknown>
  const result: Partial<Record<SocialChannel, string>> = {}
  for (const channel of channels) {
    const value = obj[channel]
    if (typeof value === 'string' && value.trim()) {
      result[channel] = value.trim()
    }
  }

  if (Object.keys(result).length === 0) {
    throw new SocialAiError('AI Router did not return usable text for any of the requested channels.')
  }

  return result
}

export type GenerateVariantsInput = {
  topic: string
  body: string
  channels: string[]
}

/**
 * Calls the existing OLNOO AI Router (lib/ai-router.ts, same client used by SEO clustering) to
 * adapt `body` into per-channel text for the requested channels only. The output language is
 * always detected from `body` itself (detectContentLanguage) — the caller's UI/interface locale
 * is never accepted here and never influences generation, only the app's own interface strings.
 * Read-only against Postgres (just looks up the project's name/domain for prompt context) —
 * never writes anything; saving the result is entirely the caller's/UI's decision.
 */
export async function generateChannelVariants(
  pool: Pool,
  projectId: number,
  input: GenerateVariantsInput,
): Promise<Partial<Record<SocialChannel, string>>> {
  const channels = input.channels.filter(isSocialChannel)
  if (channels.length === 0) {
    throw new SocialAiError('Select at least one channel before generating variants.')
  }
  if (!input.body.trim()) {
    throw new SocialAiError('Content is required before generating variants.')
  }

  const { rows } = await pool.query<{ name: string; domain: string }>('SELECT name, domain FROM projects WHERE id = $1', [
    projectId,
  ])
  const project = rows[0]
  const projectContext = project ? `${project.name} (${project.domain})` : ''

  const userPrompt = buildUserPrompt({
    topic: input.topic,
    body: input.body,
    channels,
    contentLanguage: detectContentLanguage(input.body),
    projectContext,
  })

  const content = await callAiRouter(
    [
      { role: 'system', content: SOCIAL_VARIANTS_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    { temperature: 0.4 },
  )

  return parseVariants(content, channels)
}
