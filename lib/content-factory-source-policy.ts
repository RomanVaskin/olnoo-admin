export type SourceAutomation = { mode: 'manual' | 'auto_review' | 'auto_publish'; accountId: string | null; dailyLimit: number; mediaRightsConfirmed: boolean }
export const DEFAULT_SOURCE_AUTOMATION: SourceAutomation = { mode: 'manual', accountId: null, dailyLimit: 3, mediaRightsConfirmed: false }
export function parseSourceAutomation(value: unknown): SourceAutomation {
  if (value === undefined) return { ...DEFAULT_SOURCE_AUTOMATION }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Проверьте настройки автоматизации.')
  const v = value as Record<string, unknown>
  if (Object.keys(v).some((k) => !['mode','accountId','dailyLimit','mediaRightsConfirmed'].includes(k))
    || !['manual','auto_review','auto_publish'].includes(String(v.mode))
    || !Number.isSafeInteger(v.dailyLimit) || Number(v.dailyLimit) < 1 || Number(v.dailyLimit) > 20
    || (v.accountId !== null && (typeof v.accountId !== 'string' || !v.accountId.trim()))
    || typeof v.mediaRightsConfirmed !== 'boolean'
    || (v.mode !== 'manual' && !v.accountId)) throw new Error('Выберите режим, канал проекта и лимит от 1 до 20.')
  return v as SourceAutomation
}
/** Existing external Basic Auth remains the credential verifier; Next port must be private. */
export function sourceAutomationAccess(req: Request): boolean {
  const origin = req.headers.get('origin')
  return /^Basic \S+$/i.test(req.headers.get('authorization') ?? '')
    && (origin === 'https://admin.olnoo.com' || (process.env.NODE_ENV !== 'production' && origin === new URL(req.url).origin))
}
