type FetchLike = typeof fetch

export type CrmLeadTelegramNotification = {
  project: string
  name: string
  phone?: string
  contact?: string
  service?: string
  source?: string
}

export async function notifyCrmLeadTelegram(
  lead: CrmLeadTelegramNotification,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
  const chatId = process.env.CRM_TELEGRAM_CHAT_ID?.trim()
  if (!token || !chatId) return false

  const baseUrl = (process.env.TELEGRAM_API_BASE_URL?.trim() || 'https://api.telegram.org').replace(/\/$/, '')
  const crmUrl = `https://admin.olnoo.com/en?screen=crm-leads&project=${encodeURIComponent(lead.project)}`
  const text = [
    '🆕 Новый лид в OLNOO CRM',
    '',
    `Проект: ${lead.project}`,
    `Имя: ${lead.name}`,
    lead.phone ? `Телефон: ${lead.phone}` : null,
    lead.contact ? `Контакт: ${lead.contact}` : null,
    lead.service ? `Услуга: ${lead.service}` : null,
    lead.source ? `Источник: ${lead.source}` : null,
    '',
    crmUrl,
  ].filter(Boolean).join('\n')

  const response = await fetchImpl(`${baseUrl}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Telegram returned ${response.status}${body ? `: ${body}` : ''}`)
  }
  return true
}
