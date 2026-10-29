// Контент-завод — public Telegram source adapter (first and so far only implemented adapter —
// see lib/content-factory-sources.ts's own comment for the open `type` enum that lets
// RSS/website/YouTube etc. be added later without touching this file or the DB schema).
//
// MVP deliberately reads the PUBLIC web preview of a channel (`https://t.me/s/<handle>`) rather
// than a user Telegram session or the Client API — per the task's own instruction, a public
// source should not need either. This file is the one place that depends on that HTML; nothing
// else in the Content Factory (lib/content-factory-check.ts, the items/generate/publish pipeline)
// knows or cares that the source happens to be Telegram-flavored HTML today — they only see the
// adapter's own `RawSourceMessage[]` shape. No `@/` imports — directly testable under this
// project's plain `node --test`, same convention as lib/social-telegram-comments.ts.
//
// Respects the platform rather than working around it: only ever fetches the same public page a
// signed-out browser would get, no login, no scraping behind auth, no bypassing a private/age-
// restricted channel's refusal to show a preview at all (that case surfaces as a clear error, not
// a silent empty result pretending the channel has no posts).

export class ContentFactoryTelegramSourceError extends Error {}

export type RawSourceMessage = {
  /** Stable per-channel identity (the numeric Telegram message id) — this plus the source id is
   * the DB's own UNIQUE constraint that prevents ever processing the same message twice. */
  externalId: string
  url: string
  text: string
  imageUrls: string[]
  /** ISO 8601, or '' if the preview didn't carry a parseable timestamp for this message. */
  publishedAt: string
}

/** Accepts "@channel", "channel", or a full https://t.me/channel(/...) URL — anything else is
 * rejected rather than silently guessed at. */
export function normalizeTelegramHandle(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let handle = trimmed
  const urlMatch = /^(?:https?:\/\/)?t\.me\/(?:s\/)?([a-zA-Z0-9_]+)/i.exec(trimmed)
  if (urlMatch) {
    handle = urlMatch[1]
  } else if (handle.startsWith('@')) {
    handle = handle.slice(1)
  }
  if (!/^[a-zA-Z0-9_]{5,32}$/.test(handle)) return null
  return handle
}

export function telegramPreviewUrl(handle: string): string {
  return `https://t.me/s/${handle}`
}

/**
 * Parses the public `t.me/s/<handle>` preview page into one `RawSourceMessage` per visible post,
 * oldest first (Telegram's own preview already renders oldest-to-newest top-to-bottom). A message
 * that is only a forward marker, a service message, or otherwise carries no real `data-post` id is
 * skipped. Deliberately simple regex-based extraction (no HTML/DOM dependency added just for
 * this): the preview's structure is a flat, repeated block per message
 * (`tgme_widget_message_wrap` / `data-post="<handle>/<id>"` / `tgme_widget_message_text` /
 * `tgme_widget_message_photo_wrap` with a `background-image:url('...')`), stable enough for this
 * single, narrow purpose without a general-purpose parser.
 */
export function parseTelegramPreviewHtml(html: string, handle: string): RawSourceMessage[] {
  const messages: RawSourceMessage[] = []
  const blockRe = /<div class="tgme_widget_message_wrap[^"]*"[\s\S]*?(?=<div class="tgme_widget_message_wrap|<\/section>|$)/g
  const blocks = html.match(blockRe) ?? []

  for (const block of blocks) {
    const postMatch = /data-post="([^"/]+)\/(\d+)"/.exec(block)
    if (!postMatch) continue
    const externalId = postMatch[2]

    const textMatch = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)
    const text = textMatch ? decodeTelegramHtml(stripTags(textMatch[1])) : ''

    const imageUrls: string[] = []
    const photoRe = /tgme_widget_message_photo_wrap[^"]*"\s+style="[^"]*background-image:url\('([^']+)'\)/g
    let photoMatch: RegExpExecArray | null
    while ((photoMatch = photoRe.exec(block))) {
      imageUrls.push(decodeTelegramHtml(photoMatch[1]))
    }

    const dateMatch = /<time[^>]*datetime="([^"]+)"/.exec(block)
    const publishedAt = dateMatch ? dateMatch[1] : ''

    // A message with neither text nor an image is almost certainly a service/forward marker the
    // preview still wraps in a message block — never stored as a real "publication".
    if (!text && imageUrls.length === 0) continue

    messages.push({
      externalId,
      url: `https://t.me/${handle}/${externalId}`,
      text,
      imageUrls,
      publishedAt,
    })
  }

  return messages
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function decodeTelegramHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

/**
 * Fetches and parses the public preview for one channel handle. Throws
 * `ContentFactoryTelegramSourceError` (never a raw fetch/parse exception) for every failure mode
 * the task asks to respect rather than work around: a channel that doesn't expose a public preview
 * at all (private, or Telegram itself blocking the request) surfaces as a clear, named error — this
 * adapter never attempts to authenticate, scrape around a redirect, or otherwise bypass that
 * refusal.
 */
export async function fetchPublicTelegramChannel(handle: string, fetchImpl: FetchLike = fetch as FetchLike): Promise<RawSourceMessage[]> {
  const url = telegramPreviewUrl(handle)
  let res: { ok: boolean; status: number; text(): Promise<string> }
  try {
    res = await fetchImpl(url)
  } catch (err) {
    throw new ContentFactoryTelegramSourceError(`Could not reach the Telegram preview for "${handle}": ${(err as Error).message}`)
  }
  if (!res.ok) {
    throw new ContentFactoryTelegramSourceError(
      `Telegram preview for "${handle}" is not available (HTTP ${res.status}) — the channel may be private, non-existent, or age-restricted.`,
    )
  }
  const html = await res.text()
  if (!html.includes('tgme_widget_message')) {
    throw new ContentFactoryTelegramSourceError(`"${handle}" does not look like a public Telegram channel preview — check the handle.`)
  }
  return parseTelegramPreviewHtml(html, handle)
}
