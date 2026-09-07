// Deterministic, client-side generation of SEO tasks to hand to Claude Code.
// No network calls, no DB access — built entirely from cluster/page/project data
// already loaded by the SEO Clusters view. See AGENTS.md task spec for the rules
// this template encodes.

export type TaskLocale = 'ru' | 'en'

export type TaskProject = {
  name: string
  domain: string
}

export type TaskKeyword = {
  query: string
  frequency: number | null
}

export type TaskCluster = {
  name: string
  primaryKeyword: string | null
  intent: string
  totalFrequency: number | null
  keywords: TaskKeyword[]
}

export type TaskPage = {
  url: string
  title: string | null
  h1: string | null
  description: string | null
  locale: string | null
}

function projectUrl(domain: string): string {
  return domain.startsWith('http://') || domain.startsWith('https://') ? domain : `https://${domain}`
}

function dash(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : '—'
}

function keywordsBlock(keywords: TaskKeyword[]): string {
  return [...keywords]
    .sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0))
    .map((k) => `${k.query} — ${k.frequency ?? 0}`)
    .join('\n')
}

function clusterBlock(cluster: TaskCluster): string {
  return [
    'SEO cluster:',
    '',
    `Name: ${cluster.name}`,
    `Primary keyword: ${dash(cluster.primaryKeyword)}`,
    `Intent: ${cluster.intent}`,
    `Total frequency: ${cluster.totalFrequency ?? 0}`,
    '',
    'Keywords:',
    keywordsBlock(cluster.keywords),
  ].join('\n')
}

function seoRuleBlock(): string {
  return [
    'SEO RULE:',
    '',
    'Используй весь SEO-кластер как семантическое задание для одной страницы.',
    'Не создавай отдельные страницы под близкие запросы одного search intent.',
    '',
    'Primary keyword — основной поисковый запрос страницы.',
    '',
    'Все значимые secondary keywords, темы и поисковые формулировки кластера должны быть',
    'содержательно покрыты на странице естественным образом.',
    '',
    'Не делать keyword stuffing.',
    'Не вставлять список ключей механически.',
    '',
    'Распредели семантику по подходящим элементам:',
    '- Title',
    '- meta Description',
    '- H1',
    '- H2/H3',
    '- основной контент',
    '- FAQ',
    '- коммерческие блоки',
    '',
    'Informational / question queries — использовать в FAQ или информационных разделах.',
    '',
    'Commercial queries (например: цена, стоимость, заказать, услуги, разработка, внедрение,',
    'под ключ) — раскрывать в коммерчески релевантных блоках.',
    '',
    'Не обязательно использовать каждую длинную фразу дословно, если это близкий дубль или',
    'словоформа, но каждая значимая тема/search intent внутри кластера должна быть покрыта.',
  ].join('\n')
}

function ctaRuleBlock(kind: 'improve' | 'create', intent: string): string {
  const includeCommercial = intent !== 'informational'
  const includeInformational = intent === 'informational' || intent === 'mixed'

  const lines = ['CTA / CONVERSION RULE:', '']

  if (includeCommercial) {
    lines.push(
      'Для commercial intent:',
      '- страница должна иметь понятный следующий шаг;',
      '- использовать существующий CTA/contact flow проекта;',
      '- минимум один CTA в основной части страницы;',
      '- обязательный CTA-блок ближе к концу страницы;',
      '- CTA должен вести к существующей форме заявки, контакту или другому релевантному conversion action;',
      '- не отправлять пользователя просто на главную без необходимости;',
      '- не создавать новую форму, если в проекте уже есть рабочая;',
      '- не менять существующую логику отправки заявок;',
      '- не добавлять popup или агрессивные modal CTA;',
      '- сохранить существующий дизайн сайта.',
      '',
    )
  }

  if (includeInformational) {
    lines.push(
      'Для informational intent:',
      '- использовать более мягкий CTA в конце страницы;',
      '- например переход к релевантной услуге, консультации или обсуждению задачи;',
      '- CTA должен соответствовать теме страницы и не выглядеть искусственно.',
      '',
    )
  }

  if (kind === 'improve') {
    lines.push(
      'Для Improve:',
      '- сначала проверить существующий CTA;',
      '- если существующий CTA нормальный и ведёт в рабочий conversion flow — сохранить его;',
      '- если CTA отсутствует или слабый — улучшить его средствами существующей дизайн-системы.',
      '',
    )
  } else {
    lines.push(
      'Для Create:',
      '- использовать уже существующий CTA/contact pattern ближайших service pages проекта;',
      '- не изобретать новый conversion flow.',
      '',
    )
  }

  lines.push(
    'Специально для этого проекта:',
    '- использовать существующую contact form / contact flow;',
    '- не создавать новую форму;',
    '- не менять существующий email/уведомляющий flow;',
    '- не менять работу contact form.',
  )

  return lines.join('\n')
}

function internalLinksRuleBlock(kind: 'improve' | 'create'): string {
  const lines = [
    'INTERNAL LINKS RULE:',
    '',
    'Новая или улучшенная SEO-страница не должна быть тупиковой.',
    '',
    'Проверь возможность добавить 1–3 релевантные внутренние ссылки:',
    '- на близкие service pages;',
    '- на hub page;',
    '- на contact/conversion page, если это логично.',
    '',
    'Не добавляй нерелевантные ссылки ради количества.',
    'Не создавай искусственную перелинковку.',
    '',
  ]

  if (kind === 'improve') {
    lines.push('Ссылки можно добавить прямо на странице, если это уместно и логично.')
  } else {
    lines.push(
      'Предложи, с каких существующих релевантных страниц желательно поставить внутреннюю',
      'ссылку на новую страницу. Не изменяй эти страницы автоматически без явной необходимости —',
      'в финальном отчёте просто перечисли рекомендации.',
    )
  }

  return lines.join('\n')
}

function coverageCheckBlock(): string {
  return [
    'COVERAGE CHECK:',
    '',
    'В конце обязательно проведи SEO coverage review. Проверь:',
    '1. Primary keyword covered.',
    '2. Significant secondary topics covered.',
    '3. Commercial intents covered.',
    '4. Informational/question intents covered.',
    '5. CTA соответствует intent страницы.',
    '6. Есть понятный conversion path.',
    '7. Internal linking логична.',
    '8. Нет keyword stuffing.',
    '9. Нет искусственных повторов.',
    '10. Страница полностью отвечает cluster intent.',
    '',
    'Финальный отчёт должен содержать:',
    '',
    'SEO COVERAGE',
    '',
    'Primary keyword:',
    'covered / not covered',
    '',
    'Secondary topics:',
    'X/Y covered',
    '',
    'Commercial intents:',
    'X/Y covered',
    '',
    'FAQ / informational intents:',
    'X/Y covered',
    '',
    'Missing significant topics:',
    '[...]',
    '',
    'CTA:',
    'present / missing',
    '',
    'CTA target:',
    '[...]',
    '',
    'Internal links added/recommended:',
    '[...]',
    '',
    'Keyword stuffing risk:',
    'low / medium / high',
  ].join('\n')
}

function styleGuardBlock(): string {
  return [
    'Не менять существующий визуальный стиль сайта.',
    'Не делать полный редизайн.',
    'Не добавлять generic SaaS cards.',
    'Не менять brand-logo.',
    'Не менять navigation/footer без необходимости.',
    'Не менять другие страницы без необходимости.',
    'Не менять функциональность сайта, не связанную с этой страницей.',
  ].join('\n')
}

export function buildImproveTask(
  project: TaskProject,
  cluster: TaskCluster,
  page: TaskPage,
  locale: TaskLocale,
): string {
  return [
    `Работай только в проекте сайта ${project.name} (${projectUrl(project.domain)}).`,
    '',
    `Locale: ${locale}`,
    '',
    'Целевая страница:',
    page.url,
    '',
    'Задача:',
    'улучшить существующую страницу под SEO-кластер.',
    '',
    'НЕ создавать новую страницу.',
    '',
    'Перед изменением:',
    '1. найти исходный файл страницы;',
    '2. изучить существующую структуру;',
    '3. сохранить существующий дизайн и компоненты;',
    '4. проверить текущие Title, Description, H1, H2/H3, текст, FAQ, CTA;',
    '5. изменить только то, что нужно для покрытия SEO-кластера и conversion intent.',
    '',
    clusterBlock(cluster),
    '',
    'Current page:',
    '',
    `URL: ${page.url}`,
    `Title: ${dash(page.title)}`,
    `H1: ${dash(page.h1)}`,
    `Description: ${dash(page.description)}`,
    `Locale: ${dash(page.locale ?? locale)}`,
    '',
    seoRuleBlock(),
    '',
    ctaRuleBlock('improve', cluster.intent),
    '',
    internalLinksRuleBlock('improve'),
    '',
    coverageCheckBlock(),
    '',
    styleGuardBlock(),
  ].join('\n')
}

export function buildCreateTask(project: TaskProject, cluster: TaskCluster, locale: TaskLocale): string {
  const localePrefix = locale === 'ru' ? '/ru/...' : '/en/...'
  return [
    `Работай только в проекте сайта ${project.name} (${projectUrl(project.domain)}).`,
    '',
    `Locale: ${locale}`,
    '',
    'Нужно создать ОДНУ новую SEO landing page под данный search intent.',
    '',
    clusterBlock(cluster),
    '',
    'Перед созданием:',
    '',
    '1. изучить существующие service pages проекта;',
    '2. проверить, нет ли уже страницы с тем же intent;',
    '3. выбрать ближайший существующий template/layout;',
    '4. переиспользовать существующие components;',
    '5. создать одну страницу под весь cluster;',
    '6. не создавать страницы под отдельные синонимы этого же cluster.',
    '',
    'Если обнаружена существующая страница с тем же intent:',
    '',
    'НЕ создавать дубль.',
    'Остановить создание и сообщить об этом в финальном отчёте.',
    '',
    'Предложи URL для новой страницы.',
    '',
    'URL requirements:',
    '- короткий;',
    '- понятный;',
    '- соответствует intent;',
    `- соответствует locale (${locale});`,
    `- RU → /ru/..., EN → /en/... (для этого кластера: ${localePrefix});`,
    '- не создавать несколько URL под синонимы.',
    '',
    seoRuleBlock(),
    '',
    ctaRuleBlock('create', cluster.intent),
    '',
    internalLinksRuleBlock('create'),
    '',
    coverageCheckBlock(),
    '',
    styleGuardBlock(),
  ].join('\n')
}
