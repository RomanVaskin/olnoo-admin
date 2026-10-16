import type { Pool } from 'pg'
import { callAiRouter } from './ai-router.ts'
import { buildProjectAiContext, projectAiContextBlock } from './project-ai-context.ts'
import { looksLikeMetaDescription } from './social-content-quality.ts'

// OLNOO Social AI Agent 2.0 — AI Editor for one post's Content, inside the existing post card (no
// new editor/app). Five actions edit TEXT in place (improve, shorten, punchy_opening,
// remove_ai_cliches, custom); `write_post` instead treats TEXT as a topic/brief and expands it into
// a complete post. Reuses the existing AI Router (lib/ai-router.ts) and the unified project AI
// context (lib/project-ai-context.ts) — no new provider, no Social Posts duplication: this file
// never writes to social_posts itself, it only turns TEXT into a proposed replacement TEXT for the
// caller (components/sections/social-view.tsx) to show as a diff and apply locally; persisting it
// is entirely the existing "Save" button's job, unchanged.
//
// No `@/` imports (pool injected, same convention as lib/social-agent.ts/lib/project-ai-context.ts)
// — directly testable under this project's plain `node --test`.

export class SocialAiEditorError extends Error {}

export const EDITOR_ACTIONS = ['improve', 'shorten', 'punchy_opening', 'remove_ai_cliches', 'write_post', 'custom'] as const
export type EditorAction = (typeof EDITOR_ACTIONS)[number]

export function isEditorAction(value: unknown): value is EditorAction {
  return typeof value === 'string' && (EDITOR_ACTIONS as readonly string[]).includes(value)
}

// Deliberately NOT tied to OLNOO or to any one project's persona — generic instructions, since the
// only thing that should shape voice/facts is PROJECT CONTEXT (Brand Profile + verified SEO
// context), supplied per call, never hardcoded here.
//
// Rule 4 (the "complete, publish-ready" requirement and the announcement-framing ban) mirrors the
// fix applied to the Social Agent's own planning prompt (lib/social-agent-plan.ts) — the same
// defect (writing a description of a post instead of the post) can show up here too, whether TEXT
// is already a draft post or (for the `write_post` action) just a topic/brief.
export const EDITOR_SYSTEM_PROMPT = `You are an editorial assistant that edits or writes one piece of social media post text for the project described in PROJECT CONTEXT below, following the selected action's INSTRUCTION.

Hard rules:
1. Never invent prices, services, testimonials, results, statistics, or any other fact not already present in TEXT or PROJECT CONTEXT's VERIFIED FACTS / VERIFIED SEO CONTEXT. A practical example or scenario is allowed only if explicitly marked as hypothetical (e.g. "for example, imagine..."), never presented as a real case.
2. Preserve the language of TEXT exactly — detect it from TEXT's own characters, never translate, regardless of what language PROJECT CONTEXT or INSTRUCTION happen to be written in.
3. Respect PROJECT CONTEXT's Brand Profile: match its TONE & STYLE, never violate a line in CONSTRAINTS under any instruction, and favor its PREFERRED CALL TO ACTION only where one fits naturally — never force one in.
4. The result must read as a complete, publish-ready post — an engaging opening, developed content, a natural closing — never a description or outline of a post. Announcement-style framing ("This post is about...", "We'll tell you about...", "Here we'll focus on...", "We need to write about...", or any equivalent in any language) is forbidden.
5. Return ONLY the resulting TEXT — no markdown, no code fences, no surrounding quotes, no commentary before or after, nothing else.`

const ACTION_INSTRUCTION: Record<Exclude<EditorAction, 'custom'>, string> = {
  improve:
    "Meaningfully improve TEXT: you may restructure it, rewrite the opening, and rework sentences — not limit yourself to swapping a few words — to make it clearer, more engaging, and more natural to read. Preserve every fact and claim TEXT already makes and its overall intent; keep roughly the same length unless a different one genuinely serves the post better. If TEXT is already strong, make only the changes that truly improve it — never change wording merely to produce something different.",
  shorten: "Shorten TEXT while keeping its core meaning and every fact it currently states.",
  punchy_opening:
    "Rewrite only the opening (first sentence or two) of TEXT to be more attention-grabbing; keep the rest of TEXT's meaning intact, lightly rephrasing only what's needed to stay coherent with the new opening.",
  remove_ai_cliches:
    'Rewrite TEXT to remove generic AI-sounding phrases and clichés (e.g. "in today\'s fast-paced world", "unlock the power of", "game-changer", excessive em dashes or rhetorical questions) while keeping its meaning and every fact it states exactly.',
  write_post:
    "TEXT is a topic, a set of bullet points, or a brief description of a post to write — not finished copy. Write a COMPLETE, publish-ready post from it: an engaging opening, developed content, and a natural closing. Never describe the post instead of writing it. Use only facts present in TEXT or PROJECT CONTEXT.",
}

export function buildEditorUserPrompt(input: { text: string; action: EditorAction; customInstruction: string; contextBlock: string }): string {
  const instruction = input.action === 'custom' ? input.customInstruction.trim() : ACTION_INSTRUCTION[input.action]
  return `PROJECT CONTEXT:
${input.contextBlock}

TEXT:
${input.text}

INSTRUCTION: ${instruction}

Return only the resulting TEXT, nothing else.`
}

/** Strips a markdown code fence and/or one layer of surrounding quotes a model sometimes adds
 * despite rule 4 above — never trusts the raw response verbatim. */
export function cleanEditorOutput(raw: string): string {
  let t = raw.trim()
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  }
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('«') && t.endsWith('»')))) {
    t = t.slice(1, -1).trim()
  }
  return t
}

export type EditSocialPostTextInput = {
  text: string
  action: EditorAction
  customInstruction?: string
}

/**
 * Proposes an edited version of `input.text` for one project, using the project's unified AI
 * context (Brand Profile + verified SEO context) so the result never contradicts what the project
 * is allowed to claim. Returns the proposed text; never mutates or persists anything — the caller
 * decides whether to apply (replace its own local state) or discard the proposal, and nothing
 * reaches Postgres until the existing post editor's own "Save" runs, unchanged.
 *
 * Throws `SocialAiEditorError`/`AiRouterError` on any failure (empty input, missing custom
 * instruction, AI Router error, empty/unusable response) — never a raw/untyped error, so the
 * route's own `catch` can always report the real cause instead of its generic fallback message.
 * The caller's original text is never touched by a thrown error, since this function never
 * receives or holds a reference to it beyond building the one outgoing prompt.
 */
export async function editSocialPostText(pool: Pool, projectId: number, input: EditSocialPostTextInput): Promise<string> {
  const text = input.text.trim()
  if (!text) throw new SocialAiEditorError('There is no text to edit yet.')
  if (!isEditorAction(input.action)) throw new SocialAiEditorError('Unknown editor action.')
  const customInstruction = (input.customInstruction ?? '').trim()
  if (input.action === 'custom' && !customInstruction) {
    throw new SocialAiEditorError('Write your own instruction before running a custom edit.')
  }

  const contextBlock = projectAiContextBlock(await buildProjectAiContext(pool, projectId))

  const content = await callAiRouter(
    [
      { role: 'system', content: EDITOR_SYSTEM_PROMPT },
      { role: 'user', content: buildEditorUserPrompt({ text, action: input.action, customInstruction, contextBlock }) },
    ],
    { temperature: 0.4, task: 'social-ai-editor' },
  )

  const edited = cleanEditorOutput(content)
  if (!edited) {
    throw new SocialAiEditorError('AI Router did not return usable edited text.')
  }
  // Deterministic guard (see lib/social-content-quality.ts and rule 4 of EDITOR_SYSTEM_PROMPT
  // above) — a response that describes a post instead of writing it (most likely for `write_post`,
  // but checked for every action) is rejected rather than silently proposed/applied; the caller's
  // own text is untouched either way (see this function's own doc comment), so the user can simply
  // retry without having lost anything.
  if (looksLikeMetaDescription(edited)) {
    throw new SocialAiEditorError('AI Router returned a description of the post instead of the post itself — please try again.')
  }
  return edited
}
