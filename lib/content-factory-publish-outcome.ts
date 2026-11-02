import type { SocialTelegramResult } from './social-telegram.ts'

/** A Telegram response is successful only when its publication row confirms delivery. */
export function telegramPublicationOutcome(result: SocialTelegramResult):
  | { published: true }
  | { published: false; error: string; status: number } {
  if ('error' in result) return { published: false, error: result.error, status: result.status }
  if (result.row.status === 'published') return { published: true }

  const error = typeof result.row.error === 'string' && result.row.error.trim()
    ? result.row.error
    : `Telegram publication ended with status "${String(result.row.status)}".`
  return { published: false, error, status: 502 }
}
