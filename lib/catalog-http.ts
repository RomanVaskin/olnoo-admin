/** Read only a safe application error, never surface an HTML proxy response as form validation. */
export async function catalogResponseError(response: Response, fallback: string): Promise<string> {
  if (response.status === 401 || response.status === 403) return 'Нет доступа. Проверьте авторизацию OLNOO Admin и повторите загрузку.'
  const data = await response.json().catch(() => null)
  return typeof data?.error === 'string' && data.error.trim() && data.error.length <= 500 ? data.error : fallback
}
