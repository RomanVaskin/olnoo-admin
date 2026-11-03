export const TELEGRAM_CAPTION_LIMIT = 1024
const TELEGRAM_MESSAGE_LIMIT = 4096
const SEND_TIMEOUT_MS = 20_000

export type TelegramPhotoSendResult =
  | { kind: 'sent'; messageId: number }
  | { kind: 'failed' | 'unknown'; error: string }

type BotResult = { kind: 'sent'; messageId: number } | { kind: 'failed' | 'unknown'; error: string }

async function sendBotRequest(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<BotResult> {
  let response: Response
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) })
  } catch (err) {
    return { kind: 'unknown', error: err instanceof Error ? err.message : String(err) }
  }
  let data: { ok?: boolean; description?: string; result?: { message_id?: number } | { message_id?: number }[] } | null = null
  try {
    data = await response.json()
  } catch {
    if (response.ok) return { kind: 'unknown', error: 'Telegram response body could not be read.' }
  }
  if (!response.ok) {
    return { kind: 'failed', error: data?.description || `Telegram API request failed (${response.status}).` }
  }
  if (!data?.ok) return { kind: 'unknown', error: 'Telegram returned a success status without a confirmed message.' }
  const messageId = Array.isArray(data.result) ? data.result[0]?.message_id : data.result?.message_id
  if (!Number.isSafeInteger(messageId) || !messageId || messageId <= 0) {
    return { kind: 'unknown', error: 'Telegram reported success without a message id.' }
  }
  return { kind: 'sent', messageId }
}

/** Photo and caption are one Bot API call when possible. A long text follows the photo as a
 * separate full message; any failure after the photo is treated as unknown to prevent a replay. */
export async function sendTelegramPhotoWithText(input: {
  baseUrl: string
  token: string
  chatId: string
  text: string
  image: Buffer
  mimeType?: 'image/jpeg' | 'image/png'
  fetchImpl?: typeof fetch
}): Promise<TelegramPhotoSendResult> {
  const fetchImpl = input.fetchImpl ?? fetch
  if (Array.from(input.text).length > TELEGRAM_MESSAGE_LIMIT) {
    return { kind: 'failed', error: 'Text exceeds Telegram\'s 4096-character message limit.' }
  }
  const captionFits = Array.from(input.text).length <= TELEGRAM_CAPTION_LIMIT
  const form = new FormData()
  form.set('chat_id', input.chatId)
  form.set('photo', new Blob([new Uint8Array(input.image)], { type: input.mimeType ?? 'image/jpeg' }), input.mimeType === 'image/png' ? 'original.png' : 'cover.jpg')
  if (captionFits) form.set('caption', input.text)
  const photo = await sendBotRequest(`${input.baseUrl}/bot${input.token}/sendPhoto`, { method: 'POST', body: form }, fetchImpl)
  if (photo.kind !== 'sent') return photo
  if (captionFits) return photo

  const message = await sendBotRequest(`${input.baseUrl}/bot${input.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
  }, fetchImpl)
  if (message.kind !== 'sent') {
    return { kind: 'unknown', error: `Image was sent but full text was not confirmed: ${message.error} Check Telegram before any retry.` }
  }
  return { kind: 'sent', messageId: photo.messageId }
}

/** Telegram albums contain 2–10 photos. Only the first photo gets the original caption. */
export async function sendTelegramAlbumWithText(input: {
  baseUrl: string
  token: string
  chatId: string
  text: string
  images: { bytes: Buffer; mimeType: 'image/jpeg' | 'image/png' }[]
  fetchImpl?: typeof fetch
}): Promise<TelegramPhotoSendResult> {
  if (input.images.length < 2 || input.images.length > 10) return { kind: 'failed', error: 'Telegram albums require 2–10 photos.' }
  if (Array.from(input.text).length > TELEGRAM_MESSAGE_LIMIT) return { kind: 'failed', error: 'Text exceeds Telegram\'s 4096-character message limit.' }
  const fetchImpl = input.fetchImpl ?? fetch
  const captionFits = Array.from(input.text).length <= TELEGRAM_CAPTION_LIMIT
  const form = new FormData()
  form.set('chat_id', input.chatId)
  form.set('media', JSON.stringify(input.images.map((_, index) => ({
    type: 'photo', media: `attach://photo${index}`, ...(index === 0 && captionFits ? { caption: input.text } : {}),
  }))))
  input.images.forEach((image, index) => form.set(`photo${index}`, new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }), `original${index}.${image.mimeType === 'image/png' ? 'png' : 'jpg'}`))
  const album = await sendBotRequest(`${input.baseUrl}/bot${input.token}/sendMediaGroup`, { method: 'POST', body: form }, fetchImpl)
  if (album.kind !== 'sent' || captionFits) return album
  const message = await sendBotRequest(`${input.baseUrl}/bot${input.token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: input.chatId, text: input.text }),
  }, fetchImpl)
  if (message.kind !== 'sent') return { kind: 'unknown', error: `Album was sent but full text was not confirmed: ${message.error} Check Telegram before any retry.` }
  return album
}
