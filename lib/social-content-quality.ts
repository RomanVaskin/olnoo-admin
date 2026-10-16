// OLNOO Social AI Agent — a deterministic, code-level guard against the exact defect this task
// reported: the model describing a post instead of writing it ("Пост о том, как...", "Расскажем
// о...", "Упор на...", "Необходимо написать...", and their English equivalents). The system
// prompts in lib/social-agent-plan.ts and lib/social-ai-editor.ts already forbid this, but a prompt
// is a request, not a guarantee — testing only that the prompt TEXT asks nicely would not actually
// prove the pipeline rejects a bad response. This pure, dependency-free pattern match is the real
// safety net: both files run every candidate body/text through it before accepting it, no AI calls
// added, no retry loop — a match is simply treated as unusable output, the same way an empty or
// malformed response already is.

const META_DESCRIPTION_PATTERNS: RegExp[] = [
  // Russian — the exact phrasings named in the task.
  /^пост\s+о\s+том/i,
  /^(в\s+)?этом\s+посте\s+(мы\s+)?расскаж/i,
  /^расскаж[ею]м\s+о/i,
  /^упор\s+(делаем\s+)?на/i,
  /^необходимо\s+написать/i,
  /^нужно\s+написать/i,
  /^данный\s+пост\s+(о|про|посвящ)/i,
  // English equivalents — a model can just as easily produce these instead.
  /^this post is about/i,
  /^(in\s+)?this post,?\s+we('ll| will)?\s+(tell|talk|discuss)/i,
  /^we('ll| will)\s+tell you about/i,
  /^let'?s talk about/i,
  /^here,?\s+we('ll| will)?\s+focus on/i,
  /^the focus (here|of this post) is on/i,
  /^we need to write/i,
  /^a post about/i,
  /^this is a post about/i,
]

/**
 * True when `text` OPENS with an announcement-style description of a post rather than the post's
 * own content — e.g. "Пост о том, как ИИ используется в бизнесе" instead of actually writing about
 * how AI is used in business. Only checked against the opening (a later sentence mentioning "this
 * post" in passing is not the same defect), case-insensitively, tolerant of leading whitespace.
 */
export function looksLikeMetaDescription(text: string): boolean {
  const opening = text.trim()
  return META_DESCRIPTION_PATTERNS.some((re) => re.test(opening))
}
