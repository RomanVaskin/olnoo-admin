// Fail closed on known 0042 columns; never guess that any database error means a missing migration.
export const CATALOG_MIGRATION_MESSAGE = 'Функции каталога недоступны: требуется проверка миграции 0042_istraart_manual_catalog.sql администратором. После проверки БД повторите загрузку.'
export function isCatalogMigrationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; column?: unknown; message?: unknown }
  return e.code === '42703' && [e.column, e.message].some((value) => typeof value === 'string' && /\b(istraart_style_prompt|manual_media|manual_photo_selection)\b/.test(value))
}
export function withCatalogSchemaGuard<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    try { return await handler(...args) }
    catch (error) {
      if (!isCatalogMigrationError(error)) throw error
      return Response.json({ error: CATALOG_MIGRATION_MESSAGE, code: 'CATALOG_MIGRATION_REQUIRED' }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
    }
  }
}
