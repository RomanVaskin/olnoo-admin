import { NextResponse } from 'next/server'
import { handleTelegramBusinessUpdate, isValidWebhookSecret, telegramBusinessConfig } from '@/lib/telegram-business'

export const runtime = 'nodejs'

/**
 * Telegram Business webhook (registered once by hand with setWebhook + secret_token, allowed
 * updates business_connection and business_message). Records a client's first message to the
 * connected business account as a CRM lead. Never replies: the response body is only for logs,
 * and no Bot API method that writes to a chat is called anywhere in this flow.
 */
export async function POST(req: Request) {
  const config = telegramBusinessConfig()
  if (!config) {
    return NextResponse.json({ error: 'Telegram Business intake is not configured' }, { status: 503 })
  }
  if (!isValidWebhookSecret(req.headers.get('x-telegram-bot-api-secret-token'), config.secret)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const update = await req.json().catch(() => null)
  try {
    const outcome = await handleTelegramBusinessUpdate(update, config)
    return NextResponse.json({ ok: true, ...outcome })
  } catch (error) {
    // Transient (DB / Bot API): 500 makes Telegram redeliver; lead creation is deduped.
    console.error('[tg-business] update failed:', error instanceof Error ? error.message : error)
    return NextResponse.json({ error: 'temporary failure' }, { status: 500 })
  }
}
