// Deterministic, client-side generation of SEO tasks to hand to Claude Code.
// No network calls, no DB access — built entirely from cluster/page/project data
// already loaded by the SEO Clusters view. See AGENTS.md task spec for the rules
// this template encodes.

/** Language code of the page/project ('ru', 'en', 'kk', 'de', …). Not limited to ru|en: the task never branches on it. */
export type TaskLocale = string

/** Fallback only when neither the page, the project nor the cluster gives a language. */
export const DEFAULT_TASK_LOCALE: TaskLocale = 'en'

/** Trimmed, lower-cased language code, or null when empty/missing. */
export function normalizeTaskLocale(value: string | null | undefined): TaskLocale | null {
  const v = value?.trim().toLowerCase()
  return v ? v : null
}

export type TaskProject = {
  name: string
  domain: string
  /** Default language of the project (`projects.locale` of the Project Registry), when set. */
  locale?: string | null
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

function seoRuleBlock(multi = false, safe = false): string {
  return [
    'SEO RULE:',
    '',
    ...(multi
      ? [
          'Используй ВСЕ SEO-кластеры страницы как единое семантическое задание для этой одной страницы:',
          'применяй правила ниже к совокупной семантике всех кластеров, а не к каждому по отдельности.',
          'Не создавай отдельные страницы под близкие запросы или отдельные кластеры.',
          '',
          'Primary keyword каждого кластера — основной поисковый запрос соответствующей темы страницы;',
          'главным запросом страницы считай primary keyword кластера с наибольшей суммарной частотой.',
        ]
      : [
          'Используй весь SEO-кластер как семантическое задание для одной страницы.',
          'Не создавай отдельные страницы под близкие запросы одного search intent.',
          '',
          'Primary keyword — основной поисковый запрос страницы.',
        ]),
    '',
    safe
      ? 'Максимально полно покрой релевантную подтверждённую фактами проекта семантику\n(см. BUSINESS FACTS / SEMANTIC SAFETY RULE) естественным образом.'
      : multi
        ? 'Все значимые secondary keywords, темы и поисковые формулировки всех кластеров должны быть\nсодержательно покрыты на странице естественным образом.'
        : 'Все значимые secondary keywords, темы и поисковые формулировки кластера должны быть\nсодержательно покрыты на странице естественным образом.',
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
    safe
      ? 'словоформа, но каждая значимая тема/search intent, подтверждённая фактами проекта, должна быть\nпокрыта. Неподтверждённые sub-intents не покрываются (см. BUSINESS FACTS / SEMANTIC SAFETY RULE).'
      : multi
        ? 'словоформа, но каждая значимая тема/search intent внутри каждого кластера должна быть покрыта.'
        : 'словоформа, но каждая значимая тема/search intent внутри кластера должна быть покрыта.',
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
    'Для любого проекта:',
    '- использовать существующий CTA / contact / conversion flow этого проекта;',
    '- сначала посмотреть CTA ближайших service pages и повторить их pattern;',
    '- не создавать новую форму без необходимости;',
    '- не менять существующую логику отправки заявок и уведомлений;',
    '- сохранять существующий design pattern CTA.',
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

function coverageCheckBlock(multi = false, safe = false): string {
  return [
    'COVERAGE CHECK:',
    '',
    'В конце обязательно проведи SEO coverage review. Проверь:',
    multi ? '1. Primary keyword каждого кластера covered.' : '1. Primary keyword covered.',
    safe ? '2. Significant secondary topics covered (только подтверждённые фактами проекта).' : '2. Significant secondary topics covered.',
    safe ? '3. Commercial intents covered (только подтверждённые услуги и условия).' : '3. Commercial intents covered.',
    '4. Informational/question intents covered.',
    '5. CTA соответствует intent страницы.',
    '6. Есть понятный conversion path.',
    '7. Internal linking логична.',
    '8. Нет keyword stuffing.',
    '9. Нет искусственных повторов.',
    safe
      ? '10. Страница отвечает intent подтверждённой семантики кластеров; неподтверждённые sub-intents вынесены в Intentionally not covered, самостоятельные — в CANDIDATE SEPARATE PAGES (это не FAIL).'
      : multi
        ? '10. Страница полностью отвечает intent всех кластеров.'
        : '10. Страница полностью отвечает cluster intent.',
    '',
    'Финальный отчёт должен содержать:',
    '',
    'SEO COVERAGE',
    '',
    multi ? 'Primary keyword (по каждому кластеру):' : 'Primary keyword:',
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
    safe ? '[... — без Intentionally not covered и CANDIDATE SEPARATE PAGES]' : '[...]',
    '',
    ...(safe
      ? [
          'Intentionally not covered:',
          '- <topic/query> — not confirmed by project facts',
          '(или «нет»)',
          '',
          'CANDIDATE SEPARATE PAGES',
          '- <тема>',
          '- <основные запросы>',
          '- <суммарная/доступная частотность>',
          '- <почему это отдельный intent>',
          '- recommended action: review for separate page',
          '(или «нет»)',
          '',
        ]
      : []),
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

function contentQualityGateBlock(): string {
  return [
    'CONTENT QUALITY GATE:',
    '',
    'После всех изменений сделай отдельный критический review страницы.',
    'Проверяй как скептический редактор, а не как автор текста.',
    '',
    'Обязательно найди и исправь:',
    '',
    '1. Недоказуемые утверждения.',
    '',
    'Не использовать без подтверждения формулировки типа:',
    '- "проверено на реальных проектах";',
    '- "гарантированно";',
    '- "всегда";',
    '- "одинаково работает для всех";',
    '- "лучший";',
    '- "№1";',
    '- "быстро окупается";',
    '- "даёт гарантированный рост";',
    'и аналогичные утверждения.',
    '',
    'Если утверждение не подтверждается данными проекта или исходным контентом —',
    'перепиши его в нейтральной и корректной форме.',
    '',
    'Пример:',
    'Плохо: "Одинаково работает для малого, среднего и крупного бизнеса."',
    'Хорошо: "Можно адаптировать под процессы малого, среднего и крупного бизнеса."',
    '',
    '2. Завышенные обещания.',
    '',
    'Не утверждать конкретный результат, срок, экономию, ROI, процент роста или скорость',
    'окупаемости, если это не подтверждено реальными данными проекта.',
    '',
    '3. Выдуманные факты.',
    '',
    'Не придумывать клиентов, кейсы, цифры, партнёров, сертификаты, награды, опыт,',
    'интеграции или результаты, если этого нет в исходных данных проекта.',
    '',
    '4. SEO-переспам.',
    '',
    'Проверить, нет ли искусственных повторов primary keyword, механического вставления',
    'secondary keywords или SEO-фраз, которые звучат неестественно. Если есть — переписать',
    'естественно.',
    '',
    '5. Natural language.',
    '',
    'Текст должен читаться как нормальный коммерческий или экспертный текст для человека.',
    'Не писать текст "для поискового робота".',
    '',
    '6. Scope.',
    '',
    'Не менять другие страницы, глобальную навигацию, footer, brand, дизайн-систему или',
    'функциональность, если это не нужно для конкретной SEO-страницы.',
    '',
    '7. Design.',
    '',
    'Сохранить существующий визуальный стиль страницы.',
    'Не делать полный редизайн.',
    'Не добавлять новые визуальные паттерны без необходимости.',
    '',
    '8. AI / GEO-читаемость (часть обычной Search SEO, не отдельный текст).',
    '',
    'Проверить:',
    '- ответ на основной intent страницы ясен сразу, без keyword stuffing;',
    '- структура страницы однозначна для поисковых и AI-систем: понятные H1/H2/H3 по смысловым',
    '  sub-intents, один основной intent;',
    '- важные business facts (кто, что, где, условия) сформулированы явно и непротиворечиво —',
    '  только подтверждённые данными проекта;',
    '- FAQ используется только там, где он действительно полезен для читателя;',
    '- не создан отдельный GEO/AEO-текст: обычная Search SEO остаётся основой;',
    '- не добавлены llms.txt, новая schema.org-разметка и другие специальные AI-файлы;',
    '- factual guardrail (BUSINESS FACTS / SEMANTIC SAFETY RULE) соблюдён.',
    '',
    'ОБЯЗАТЕЛЬНОЕ ПРАВИЛО:',
    '',
    'Любое утверждение о факте, которого нет в исходном проекте или в предоставленных',
    'данных, считать неподтверждённым и переписывать в нейтральной форме.',
    '',
    'После SEO COVERAGE обязательно выведи:',
    '',
    'QUALITY GATE',
    '',
    'Unsupported claims:',
    'PASS / FIXED / FAIL',
    '',
    'Overpromising:',
    'PASS / FIXED / FAIL',
    '',
    'Invented facts:',
    'PASS / FIXED / FAIL',
    '',
    'Keyword stuffing:',
    'PASS / FIXED / FAIL',
    '',
    'Natural language:',
    'PASS / FIXED / FAIL',
    '',
    'Scope respected:',
    'PASS / FAIL',
    '',
    'Design preserved:',
    'PASS / FAIL',
    '',
    'AI/GEO readiness:',
    'PASS / FIXED / FAIL',
    '',
    'Если обнаружена проблема — сначала исправь её и только потом завершай задачу.',
    'Не завершать задачу со статусом FAIL.',
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

/** Page clusters kept for analytics only: listed by name/intent/frequency, never with keywords. */
export type TaskAnalyticsCluster = {
  name: string
  intent: string
  totalFrequency: number | null
}

function analyticsClustersBlock(clusters: TaskAnalyticsCluster[]): string {
  return [
    `Аналитические кластеры страницы (${clusters.length}) — НЕ входят в content scope:`,
    '',
    ...clusters.map((c) => `- ${c.name} (intent: ${c.intent}, total frequency: ${c.totalFrequency ?? 0})`),
    '',
    'Эти кластеры привязаны к странице только для аналитики. НЕ оптимизируй страницу под них,',
    'не покрывай и не упоминай их запросы и бренды. SEO RULE, CTA, COVERAGE CHECK и Quality Gate',
    'относятся только к кластерам content scope.',
  ].join('\n')
}

function businessFactsGuardBlock(): string {
  return [
    'BUSINESS FACTS / SEMANTIC SAFETY RULE:',
    '',
    'SEO keywords и SEO clusters описывают поисковый спрос, но НЕ являются источником фактов о бизнесе.',
    '',
    'Нельзя утверждать или добавлять на страницу только на основании SEO-семантики:',
    '- новую услугу или новый тип работ;',
    '- обслуживание конкретного города/района;',
    '- работу с конкретной аудиторией или сегментом клиентов;',
    '- рекламную/брендированную или иную специализированную разновидность услуги;',
    '- конкретный бренд или материал;',
    '- цену, скидку, гарантию, срок;',
    '- наличие оборудования, партнёрство, сертификат;',
    '- любую другую возможность бизнеса.',
    '',
    'Перед добавлением такого факта найди подтверждение в существующем проекте (включая ближайшие',
    'страницы и текущую страницу, если она есть) или предоставленных project facts. Если подтверждения нет:',
    '1. НЕ добавлять утверждение на страницу.',
    '2. НЕ пытаться механически покрыть keyword.',
    '3. Считать такой keyword/sub-intent intentionally not covered.',
    '4. Указать его в финальном SEO COVERAGE в поле «Intentionally not covered»:',
    '   - <topic/query> — not confirmed by project facts',
    'Это НЕ FAIL, и не повод выдумывать контент.',
    '',
    'Различай три случая:',
    '',
    'A. Семантические варианты подтверждённой услуги (синонимы, словоформы, близкие названия',
    'того же предложения) — используй естественно.',
    '',
    'B. Новый бизнес-факт или sub-intent, которого нет в проекте — не добавляй, это',
    'intentionally not covered. Присутствие запроса в confirmed-кластере не делает его',
    'существующей услугой.',
    '',
    'C. Самостоятельный search intent: группа запросов с отдельным commercial intent,',
    'отдельным сценарием/аудиторией/услугой, потенциально требующая другого оффера, цены, CTA',
    'или содержания и логичнее раскрываемая отдельной посадочной. НЕ покрывай её искусственно на',
    'этой странице и НЕ создавай для неё новую страницу в рамках этой задачи. Вынеси в блок CANDIDATE SEPARATE PAGES финального',
    'SEO COVERAGE (тема, основные запросы, суммарная/доступная частотность, почему это отдельный',
    'intent, recommended action: review for separate page). Это не Missing significant topic и не',
    'FAIL. Кандидатом может быть только самостоятельная группа запросов, а не каждый long-tail',
    'keyword; вариант основного intent остаётся на странице.',
    '',
    'Content scope страницы определяется кластерами, переданными выше; запросы, относящиеся к',
    'другим услугам или сегментам, не расширяют его.',
  ].join('\n')
}

function clustersListBlock(clusters: TaskCluster[], scoped: boolean): string {
  const parts = [
    scoped
      ? `Content scope — SEO clusters страницы, обязательные для content coverage (${clusters.length}):`
      : `SEO clusters страницы (${clusters.length}):`,
  ]
  clusters.forEach((c, i) => {
    parts.push(
      '',
      `Cluster ${i + 1}/${clusters.length}`,
      '',
      `Name: ${c.name}`,
      `Primary keyword: ${dash(c.primaryKeyword)}`,
      `Intent: ${c.intent}`,
      `Total frequency: ${c.totalFrequency ?? 0}`,
      '',
      'Keywords:',
      keywordsBlock(c.keywords),
    )
  })
  return parts.join('\n')
}

// One cluster → its own intent. Several → shared intent if all agree, otherwise 'mixed'
// (which makes the CTA rule include both commercial and informational guidance).
function combinedIntent(clusters: TaskCluster[]): string {
  const intents = new Set(clusters.map((c) => c.intent))
  return intents.size === 1 ? clusters[0].intent : 'mixed'
}

/**
 * Improve task for ONE existing page. Accepts a single cluster or all clusters confirmed for the page;
 * a single cluster yields the classic prompt unchanged.
 */
export function buildImproveTask(
  project: TaskProject,
  clusterOrClusters: TaskCluster | TaskCluster[],
  page: TaskPage,
  locale: TaskLocale,
  analyticsOnly: TaskAnalyticsCluster[] = [],
): string {
  const clusters = Array.isArray(clusterOrClusters) ? clusterOrClusters : [clusterOrClusters]
  if (clusters.length === 0) throw new Error('buildImproveTask: at least one cluster is required')
  const multi = clusters.length > 1

  return [
    `Работай только в проекте сайта ${project.name} (${projectUrl(project.domain)}).`,
    '',
    `Locale: ${locale}`,
    '',
    'Целевая страница:',
    page.url,
    '',
    'Задача:',
    multi
      ? 'улучшить существующую страницу под ВСЕ перечисленные ниже SEO-кластеры (одна страница — одна задача).'
      : 'улучшить существующую страницу под SEO-кластер.',
    '',
    'НЕ создавать новую страницу.',
    '',
    'Перед изменением:',
    '1. найти исходный файл страницы;',
    '2. изучить существующую структуру;',
    '3. сохранить существующий дизайн и компоненты;',
    '4. проверить текущие Title, Description, H1, H2/H3, текст, FAQ, CTA;',
    multi
      ? '5. изменить только то, что нужно для покрытия всех SEO-кластеров страницы и conversion intent.'
      : '5. изменить только то, что нужно для покрытия SEO-кластера и conversion intent.',
    '',
    ...(multi
      ? [clustersListBlock(clusters, analyticsOnly.length > 0)]
      : analyticsOnly.length > 0
        ? ['Content scope — SEO cluster, обязательный для content coverage:', '', clusterBlock(clusters[0])]
        : [clusterBlock(clusters[0])]),
    '',
    ...(analyticsOnly.length > 0 ? [analyticsClustersBlock(analyticsOnly), ''] : []),
    'Current page:',
    '',
    `URL: ${page.url}`,
    `Title: ${dash(page.title)}`,
    `H1: ${dash(page.h1)}`,
    `Description: ${dash(page.description)}`,
    `Locale: ${dash(page.locale ?? locale)}`,
    '',
    businessFactsGuardBlock(),
    '',
    seoRuleBlock(multi, true),
    '',
    ctaRuleBlock('improve', multi ? combinedIntent(clusters) : clusters[0].intent),
    '',
    internalLinksRuleBlock('improve'),
    '',
    coverageCheckBlock(multi, true),
    '',
    contentQualityGateBlock(),
    '',
    styleGuardBlock(),
  ].join('\n')
}

export function buildCreateTask(project: TaskProject, cluster: TaskCluster, locale: TaskLocale): string {
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
    '- следует существующей URL-структуре проекта (изучи URL существующих страниц);',
    '- без языкового префикса (/ru/, /en/ и т. п.), если проект его не использует;',
    '- если существующие страницы проекта используют префикс языка — сохрани его для языка этой страницы;',
    '- не создавать несколько URL под синонимы.',
    '',
    businessFactsGuardBlock(),
    '',
    seoRuleBlock(false, true),
    '',
    ctaRuleBlock('create', cluster.intent),
    '',
    internalLinksRuleBlock('create'),
    '',
    coverageCheckBlock(false, true),
    '',
    contentQualityGateBlock(),
    '',
    styleGuardBlock(),
  ].join('\n')
}
