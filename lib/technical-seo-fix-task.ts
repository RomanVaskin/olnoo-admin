// Technical SEO Fix task: turns issues found by the Technical SEO check (lib/seo-health.ts) into ONE prompt for Claude/Codex.
// Pure (no network, no DB, no `@/` imports) so a future agent can call the same function. The scanner supplies diagnostic facts only;
// the prompt forbids inventing business facts. Nothing here writes to any repository.
import type { Issue, PageCheck, ProjectHealth } from './seo-health.ts'

export type FixTaskProject = Pick<ProjectHealth, 'projectName' | 'domain' | 'sitemapUrl' | 'robots' | 'sitemap' | 'pages'> & {
  /** Only when the project metadata really has it; never guessed. */
  repository?: string | null
}

/** Same issue (code + URL) never appears twice; ERRORs first, then WARNINGs, then by code and URL. */
export function dedupeIssues(issues: readonly Issue[]): Issue[] {
  const seen = new Set<string>()
  const out: Issue[] = []
  for (const i of issues) {
    const key = `${i.severity}|${i.code}|${i.url ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(i)
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'ERROR' ? -1 : 1) || a.code.localeCompare(b.code) || (a.url ?? '').localeCompare(b.url ?? ''))
}

const val = (v: string | number | null | undefined) => (v === null || v === undefined || v === '' ? 'нет' : String(v))

function pageFacts(p: PageCheck): string {
  const parts = [`HTTP ${val(p.httpStatus)}`, `canonical: ${val(p.canonical)}`, `индексация: ${p.indexing}`, `Title: ${val(p.title)}`, `H1: ${val(p.h1)}`]
  if (p.redirectTo) parts.push(`redirect → ${p.redirectTo}`)
  return parts.join(' · ')
}

/** Per-code fix rules; only the codes present in the task are included. */
const RULES: Record<string, string> = {
  robots_missing:
    'robots_missing: создай стандартный robots-механизм существующего framework (для Next.js App Router — `app/robots.ts`, если архитектура проекта это позволяет). Публичный сайт не закрывай; добавь ссылку на существующий sitemap (адрес указан выше).',
  robots_unreadable:
    'robots_unreadable: сначала выясни, почему robots.txt не отдаётся (route, rewrite, ошибка сервера). Исправь причину стандартным механизмом framework; публичный сайт не закрывай.',
  robots_disallow_all:
    'robots_disallow_all: robots.txt закрывает весь сайт (`Disallow: /`). Определи, намеренно ли это (например, закрытое окружение). Если сайт публичный — открой индексацию стандартным механизмом framework и добавь ссылку на sitemap; если закрытие намеренное — ничего не меняй и укажи это в отчёте.',
  sitemap_missing:
    'sitemap_missing: используй стандартный механизм framework (для Next.js App Router — `app/sitemap.ts`). Включай только публичные canonical indexable URL. Генерируй sitemap из существующих routes/данных, а не ручным списком, который быстро устареет.',
  sitemap_unreadable:
    'sitemap_unreadable: найди, почему sitemap не читается (не XML, ошибка, неверный адрес). Исправь причину стандартным механизмом framework; включай только публичные canonical indexable URL, генерируй из существующих routes/данных.',
  canonical_missing: 'canonical_missing: добавь canonical только на проблемной странице; он должен соответствовать публичному canonical URL этой страницы.',
  canonical_mismatch: 'canonical_mismatch: исправь canonical только на проблемной странице, чтобы он указывал на её публичный canonical URL.',
  noindex_in_sitemap:
    'noindex_in_sitemap: сначала определи назначение страницы. (а) Если страница должна индексироваться — убери noindex. (б) Если не должна — убери её из sitemap. Не снимай noindex автоматически без проверки назначения страницы.',
  title_missing: 'title_missing: добавь Title на существующую страницу; существующий SEO-контент без необходимости не переписывай.',
  h1_missing: 'h1_missing: добавь один логичный H1 средствами существующего дизайна; не создавай SEO-текст ради H1.',
  page_redirect: 'page_redirect: если URL не должен находиться в sitemap — исправь sitemap (укажи конечный canonical URL). Рабочий redirect не ломай.',
  page_http_error: 'page_http_error: сначала определи причину (удалённая страница, неверный route, неверная ссылка в sitemap). Минимально исправь route/ссылку/sitemap; проблему не маскируй.',
  page_unreachable: 'page_unreachable: сначала определи причину (ошибка сервера, таймаут, неверный URL). Минимально исправь route/ссылку/sitemap; проблему не маскируй.',
  site_unavailable: 'site_unavailable: сайт не отвечает по основному URL. Это, скорее всего, вопрос инфраструктуры — не меняй deploy/nginx/systemd; опиши причину и что нужно сделать владельцу.',
}

/**
 * ONE prompt for the given issues of ONE project (all issues for «Fix all», a single one for «Fix»). Returns null when there is
 * nothing to fix. `issues` should come from this project's check; duplicates are removed here.
 */
export function buildTechnicalSeoFixTask(project: FixTaskProject, issues: readonly Issue[]): string | null {
  const list = dedupeIssues(issues)
  if (list.length === 0) return null

  const pageByUrl = new Map(project.pages.map((p) => [p.url, p]))

  const lines: string[] = []
  lines.push('TECHNICAL SEO FIX TASK', '')
  lines.push('Исправь найденные Technical SEO проблемы публичного сайта. Одна задача — один проект.', '')
  lines.push('PROJECT')
  lines.push(`- Название: ${project.projectName}`)
  lines.push(`- Domain: ${project.domain}`)
  if (project.repository) lines.push(`- Repository/path: ${project.repository}`)
  lines.push(`- Sitemap URL: ${project.sitemapUrl ?? 'не определён'}`)
  lines.push(`- robots.txt: ${project.robots.httpStatus ? `HTTP ${project.robots.httpStatus}` : 'нет ответа'}${project.robots.disallowAll ? ' (Disallow: / для всех)' : ''}`)
  lines.push(`- Sitemap: ${project.sitemap.httpStatus ? `HTTP ${project.sitemap.httpStatus}` : 'нет ответа'}${project.sitemap.urlCount !== null ? `, URL в sitemap: ${project.sitemap.urlCount}` : ''}`)
  lines.push('', `ISSUES (${list.length})`)
  list.forEach((i, n) => {
    lines.push(`${n + 1}. [${i.severity}] ${i.code} — ${i.message}`)
    if (i.url) {
      lines.push(`   URL: ${i.url}`)
      const p = pageByUrl.get(i.url)
      if (p) lines.push(`   Факты: ${pageFacts(p)}`)
    }
  })

  const codes = [...new Set(list.map((i) => i.code))].filter((c) => RULES[c])
  if (codes.length) {
    lines.push('', 'ПРАВИЛА ИСПРАВЛЕНИЯ ДЛЯ НАЙДЕННЫХ ПРОБЛЕМ')
    for (const c of codes) lines.push(`- ${RULES[c]}`)
  }

  lines.push(
    '',
    'ОБЩИЕ ПРАВИЛА',
    '- Сначала изучи существующую реализацию проекта и используй его framework и conventions.',
    '- Исправляй минимальным patch; не делай редизайн и не меняй бизнес-логику.',
    '- Не меняй формы, analytics, CRM, Ads, deploy, nginx/systemd/GitHub Actions без необходимости.',
    '- Не трогай чужие незакоммиченные изменения.',
    '- Secrets и media в Git не добавляй.',
    '',
    'BUSINESS FACTS RULE',
    'Technical SEO scanner — источник диагностических фактов (статусы, canonical, индексация, Title, H1), но не источник бизнес-фактов. Не придумывай услуги, цены, города, гарантии, материалы и контент. Тексты (Title, H1) бери из существующего контента страницы.',
    '',
    'РЕЗУЛЬТАТ (в финальном отчёте)',
    '1. Список root causes.',
    '2. Изменённые файлы.',
    '3. Какие issues исправлены.',
    '4. Какие issues intentionally not fixed и почему.',
    '5. Результаты npm test / typecheck / build / git diff --check (по необходимости).',
    '',
    'GIT',
    '- Создай отдельную ветку, сделай commit, открой PR в main.',
    '- НЕ делай merge.',
    '- После merge владелец вручную нажмёт «Проверить все» в Technical SEO.',
  )
  return lines.join('\n')
}
