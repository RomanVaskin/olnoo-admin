/** Uses the existing posting bot. Never expose Bot API URLs, raw errors or file paths to clients. */
export async function ownMaterialBotCall(method: string, data: Record<string, unknown>): Promise<unknown> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  if (!token) throw new Error('Telegram bot is not configured')
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(15000) }).catch(() => { throw new Error('Telegram Bot API unavailable') })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.ok) throw new Error('Telegram Bot API request failed')
  return result.result
}
export async function ownMaterialPhoto(fileId: string): Promise<Buffer> {
  const file = await ownMaterialBotCall('getFile', { file_id: fileId }) as { file_path?: string; file_size?: number }
  if (!file.file_path || !/^photos\/[a-zA-Z0-9_-]+\.jpe?g$/.test(file.file_path) || (file.file_size ?? 0) > 10 * 1024 * 1024) throw new Error('Unsupported Telegram photo')
  const response = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) }).catch(() => { throw new Error('Telegram photo unavailable') })
  if (!response.ok || !response.body) throw new Error('Telegram photo unavailable')
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 10 * 1024 * 1024) throw new Error('Telegram photo exceeds 10 MB')
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks)
}
