export type Status =
  | 'Mapped'
  | 'No page'
  | 'Missing'
  | 'Draft'
  | 'Live'
  | 'Synced'
  | 'Pending'

export type ModuleKey = 'SEO' | 'CRM' | 'Social' | 'Ads' | 'PR' | 'Analytics'

export const ALL_MODULES: ModuleKey[] = [
  'SEO',
  'CRM',
  'Social',
  'Ads',
  'PR',
  'Analytics',
]

export const MODULE_STATE: Record<ModuleKey, 'active' | 'soon'> = {
  SEO: 'active',
  CRM: 'active',
  Social: 'soon',
  Ads: 'soon',
  PR: 'soon',
  Analytics: 'soon',
}

export type Project = {
  id: string
  name: string
  domain: string
  sitemap: string
  client: string
  modules: ModuleKey[]
  pages: number
  keywords: number
  leads: number | null
  status: 'Synced' | 'Pending'
  lastSync: string
}

export type Client = {
  id: string
  name: string
  projectCount: number
  modules: ModuleKey[]
  contact: string
  status: 'Active'
}

export type LeadStatus = 'New' | 'In progress' | 'Proposal' | 'Won' | 'Lost'

export type Lead = {
  id: string
  name: string
  company: string
  email: string
  service: string
  source: 'SEO' | 'Ads' | 'Telegram' | 'Direct' | 'Referral'
  landingPage: string
  status: LeadStatus
  created: string
  message: string
  referrer: string
  utmSource: string
  utmMedium: string
  utmCampaign: string
  locale: string
  notes: string
  activity: { date: string; text: string }[]
}

export type Page = {
  url: string
  title: string
  h1: string
  locale: string
  targetKeyword: string
  status: 'Live' | 'Draft'
}

export type Keyword = {
  keyword: string
  frequency: number
  region: string
  cluster: string
  targetPage: string
  status: 'Mapped' | 'No page'
}

export type Cluster = {
  name: string
  items: {
    keyword: string
    page: string
    status: 'Mapped' | 'Missing'
  }[]
}

export type ImportRecord = {
  file: string
  project: string
  rows: number
  date: string
  status: 'Imported' | 'Pending'
}

export const projects: Project[] = [
  {
    id: 'olnoo',
    name: 'OLNOO',
    domain: 'olnoo.com',
    sitemap: '/sitemap.xml',
    client: 'OLNOO',
    modules: ['SEO', 'CRM'],
    pages: 42,
    keywords: 118,
    leads: 18,
    status: 'Synced',
    lastSync: '2026-09-05 14:20',
  },
  {
    id: 'insurance',
    name: 'OLNOO Insurance',
    domain: 'insurance.olnoo.com',
    sitemap: '/sitemap.xml',
    client: 'OLNOO Insurance',
    modules: ['SEO'],
    pages: 28,
    keywords: 74,
    leads: null,
    status: 'Synced',
    lastSync: '2026-09-05 11:02',
  },
  {
    id: 'aura',
    name: 'Aura Estate',
    domain: 'aura.olnoo.com',
    sitemap: '/sitemap.xml',
    client: 'Aura Estate',
    modules: ['SEO', 'CRM'],
    pages: 19,
    keywords: 46,
    leads: 12,
    status: 'Pending',
    lastSync: '2026-09-03 09:48',
  },
]

export const clients: Client[] = [
  {
    id: 'olnoo',
    name: 'OLNOO',
    projectCount: 1,
    modules: ['SEO', 'CRM'],
    contact: 'Internal',
    status: 'Active',
  },
  {
    id: 'insurance',
    name: 'OLNOO Insurance',
    projectCount: 1,
    modules: ['SEO'],
    contact: 'Internal',
    status: 'Active',
  },
  {
    id: 'aura',
    name: 'Aura Estate',
    projectCount: 1,
    modules: ['SEO', 'CRM'],
    contact: 'Internal',
    status: 'Active',
  },
]

export const pages: Page[] = [
  {
    url: '/ru/services/business-automation',
    title: 'Автоматизация бизнеса — OLNOO',
    h1: 'Автоматизация бизнеса',
    locale: 'RU',
    targetKeyword: 'автоматизация бизнеса',
    status: 'Live',
  },
  {
    url: '/ru/services/ai-agents',
    title: 'ИИ-агенты для бизнеса — OLNOO',
    h1: 'ИИ-агенты для бизнеса',
    locale: 'RU',
    targetKeyword: 'ии агенты для бизнеса',
    status: 'Live',
  },
  {
    url: '/ru/services/crm-automation',
    title: 'Автоматизация CRM — OLNOO',
    h1: 'Автоматизация CRM',
    locale: 'RU',
    targetKeyword: 'автоматизация crm',
    status: 'Draft',
  },
  {
    url: '/ru/services/telegram-bots',
    title: 'Telegram-боты и Mini Apps — OLNOO',
    h1: 'Telegram-боты для продаж',
    locale: 'RU',
    targetKeyword: 'разработка telegram ботов',
    status: 'Live',
  },
  {
    url: '/en/services/market-entry',
    title: 'International Market Entry — OLNOO',
    h1: 'Market entry & localisation',
    locale: 'EN',
    targetKeyword: 'international market entry',
    status: 'Live',
  },
  {
    url: '/ru/cases/nordwind-freight',
    title: 'Кейс Nordwind Freight — OLNOO',
    h1: 'Операционный ИИ-контур',
    locale: 'RU',
    targetKeyword: 'операционный ии для логистики',
    status: 'Draft',
  },
]

export const keywords: Keyword[] = [
  {
    keyword: 'автоматизация бизнеса',
    frequency: 3200,
    region: 'Москва',
    cluster: 'AI Automation',
    targetPage: '/ru/services/business-automation',
    status: 'Mapped',
  },
  {
    keyword: 'ии агенты для бизнеса',
    frequency: 740,
    region: 'Москва',
    cluster: 'AI Agents',
    targetPage: '/ru/services/ai-agents',
    status: 'Mapped',
  },
  {
    keyword: 'автоматизация crm',
    frequency: 430,
    region: 'Москва',
    cluster: 'CRM',
    targetPage: '—',
    status: 'No page',
  },
  {
    keyword: 'разработка telegram ботов',
    frequency: 1900,
    region: 'Москва',
    cluster: 'Telegram',
    targetPage: '/ru/services/telegram-bots',
    status: 'Mapped',
  },
  {
    keyword: 'ии ассистент для продаж',
    frequency: 590,
    region: 'Санкт-Петербург',
    cluster: 'AI Agents',
    targetPage: '—',
    status: 'No page',
  },
  {
    keyword: 'международный маркетинг',
    frequency: 880,
    region: 'Москва',
    cluster: 'Growth',
    targetPage: '/en/services/market-entry',
    status: 'Mapped',
  },
  {
    keyword: 'seo продвижение b2b',
    frequency: 1200,
    region: 'Москва',
    cluster: 'Growth',
    targetPage: '—',
    status: 'No page',
  },
  {
    keyword: 'внедрение crm битрикс24',
    frequency: 2100,
    region: 'Москва',
    cluster: 'CRM',
    targetPage: '—',
    status: 'No page',
  },
]

export const clusters: Cluster[] = [
  {
    name: 'AI Automation',
    items: [
      {
        keyword: 'автоматизация бизнеса',
        page: '/ru/services/business-automation',
        status: 'Mapped',
      },
      {
        keyword: 'ии агенты для бизнеса',
        page: '/ru/services/ai-agents',
        status: 'Mapped',
      },
      { keyword: 'автоматизация crm', page: '—', status: 'Missing' },
    ],
  },
  {
    name: 'AI Agents',
    items: [
      {
        keyword: 'ии агенты для бизнеса',
        page: '/ru/services/ai-agents',
        status: 'Mapped',
      },
      { keyword: 'ии ассистент для продаж', page: '—', status: 'Missing' },
    ],
  },
  {
    name: 'CRM',
    items: [
      { keyword: 'автоматизация crm', page: '—', status: 'Missing' },
      { keyword: 'внедрение crm битрикс24', page: '—', status: 'Missing' },
    ],
  },
  {
    name: 'Telegram',
    items: [
      {
        keyword: 'разработка telegram ботов',
        page: '/ru/services/telegram-bots',
        status: 'Mapped',
      },
    ],
  },
  {
    name: 'Growth',
    items: [
      {
        keyword: 'международный маркетинг',
        page: '/en/services/market-entry',
        status: 'Mapped',
      },
      { keyword: 'seo продвижение b2b', page: '—', status: 'Missing' },
    ],
  },
]

export const recentImports: ImportRecord[] = [
  {
    file: 'wordstat_olnoo_ru_sep.xlsx',
    project: 'OLNOO',
    rows: 214,
    date: '2026-09-05',
    status: 'Imported',
  },
  {
    file: 'wordstat_insurance_aug.csv',
    project: 'OLNOO Insurance',
    rows: 96,
    date: '2026-08-28',
    status: 'Imported',
  },
  {
    file: 'wordstat_aura_estate.csv',
    project: 'Aura Estate',
    rows: 61,
    date: '2026-08-19',
    status: 'Imported',
  },
]

export const previewRows = [
  { keyword: 'автоматизация бизнеса', frequency: 3200, region: 'Москва' },
  { keyword: 'ии агенты для бизнеса', frequency: 740, region: 'Москва' },
  { keyword: 'автоматизация crm', frequency: 430, region: 'Москва' },
  { keyword: 'внедрение crm битрикс24', frequency: 2100, region: 'Москва' },
  { keyword: 'seo продвижение b2b', frequency: 1200, region: 'Москва' },
]

export const metrics = {
  projects: projects.length,
  pages: projects.reduce((s, p) => s + p.pages, 0),
  keywords: projects.reduce((s, p) => s + p.keywords, 0),
  mappedKeywords: keywords.filter((k) => k.status === 'Mapped').length,
  missingPages: keywords.filter((k) => k.status === 'No page').length,
}

export const leads: Lead[] = [
  {
    id: 'lead-01',
    name: 'Иван Петров',
    company: 'ABC Group',
    email: 'ivan@example.com',
    service: 'AI Agents',
    source: 'SEO',
    landingPage: '/ru/services/ai-agents',
    status: 'New',
    created: '06 Sep 2026',
    message:
      'Интересует внедрение ИИ-агентов для отдела продаж. Хотим обсудить пилот на 3 месяца.',
    referrer: 'yandex.ru',
    utmSource: 'yandex',
    utmMedium: 'organic',
    utmCampaign: 'ai-agents-ru',
    locale: 'ru-RU',
    notes: 'Тёплый лид из органики. Запросить бриф по процессам.',
    activity: [
      { date: '06 Sep', text: 'Lead created' },
      { date: '06 Sep', text: 'Assigned to sales' },
    ],
  },
  {
    id: 'lead-02',
    name: 'Мария Орлова',
    company: 'Techline',
    email: 'maria@example.com',
    service: 'Business Automation',
    source: 'Direct',
    landingPage: '/ru/services/business-automation',
    status: 'In progress',
    created: '06 Sep 2026',
    message: 'Нужна автоматизация внутренних операций и отчётности.',
    referrer: '—',
    utmSource: '—',
    utmMedium: '—',
    utmCampaign: '—',
    locale: 'ru-RU',
    notes: 'Назначен звонок на 09 Sep.',
    activity: [
      { date: '06 Sep', text: 'Lead created' },
      { date: '06 Sep', text: 'Status changed: New → In progress' },
    ],
  },
  {
    id: 'lead-03',
    name: 'Дмитрий Соколов',
    company: 'Nordwind Freight',
    email: 'dmitry@example.com',
    service: 'Operational AI',
    source: 'Referral',
    landingPage: '/ru/cases/nordwind-freight',
    status: 'Proposal',
    created: '05 Sep 2026',
    message: 'После кейса Nordwind — хотим похожий операционный контур.',
    referrer: 'partner',
    utmSource: 'referral',
    utmMedium: 'partner',
    utmCampaign: 'nordwind-case',
    locale: 'ru-RU',
    notes: 'Отправлено коммерческое предложение. Ждём ответ.',
    activity: [
      { date: '03 Sep', text: 'Lead created' },
      { date: '04 Sep', text: 'Status changed: New → In progress' },
      { date: '05 Sep', text: 'Status changed: In progress → Proposal' },
    ],
  },
  {
    id: 'lead-04',
    name: 'Anna Weber',
    company: 'Meridian GmbH',
    email: 'anna@example.com',
    service: 'Market Entry',
    source: 'SEO',
    landingPage: '/en/services/market-entry',
    status: 'Won',
    created: '04 Sep 2026',
    message: 'Looking for support entering the CIS market.',
    referrer: 'google.com',
    utmSource: 'google',
    utmMedium: 'organic',
    utmCampaign: 'market-entry-en',
    locale: 'en-US',
    notes: 'Signed. Kickoff scheduled.',
    activity: [
      { date: '01 Sep', text: 'Lead created' },
      { date: '02 Sep', text: 'Status changed: New → In progress' },
      { date: '03 Sep', text: 'Status changed: In progress → Proposal' },
      { date: '04 Sep', text: 'Status changed: Proposal → Won' },
    ],
  },
  {
    id: 'lead-05',
    name: 'Олег Кузнецов',
    company: 'RetailPro',
    email: 'oleg@example.com',
    service: 'CRM Automation',
    source: 'Ads',
    landingPage: '/ru/services/crm-automation',
    status: 'New',
    created: '05 Sep 2026',
    message: 'Внедрение и автоматизация CRM для розничной сети.',
    referrer: 'yandex.direct',
    utmSource: 'yandex',
    utmMedium: 'cpc',
    utmCampaign: 'crm-automation',
    locale: 'ru-RU',
    notes: '',
    activity: [{ date: '05 Sep', text: 'Lead created' }],
  },
  {
    id: 'lead-06',
    name: 'Елена Смирнова',
    company: 'FinGroup',
    email: 'elena@example.com',
    service: 'Telegram Bots',
    source: 'Telegram',
    landingPage: '/ru/services/telegram-bots',
    status: 'In progress',
    created: '04 Sep 2026',
    message: 'Нужен Telegram-бот для обработки заявок и оплаты.',
    referrer: 't.me',
    utmSource: 'telegram',
    utmMedium: 'social',
    utmCampaign: 'tg-bots',
    locale: 'ru-RU',
    notes: 'Уточнить требования по интеграции с оплатой.',
    activity: [
      { date: '04 Sep', text: 'Lead created' },
      { date: '04 Sep', text: 'Status changed: New → In progress' },
    ],
  },
  {
    id: 'lead-07',
    name: 'Павел Морозов',
    company: 'LogiTrans',
    email: 'pavel@example.com',
    service: 'Business Automation',
    source: 'SEO',
    landingPage: '/ru/services/business-automation',
    status: 'New',
    created: '03 Sep 2026',
    message: 'Автоматизация логистических операций.',
    referrer: 'yandex.ru',
    utmSource: 'yandex',
    utmMedium: 'organic',
    utmCampaign: 'automation-ru',
    locale: 'ru-RU',
    notes: '',
    activity: [{ date: '03 Sep', text: 'Lead created' }],
  },
  {
    id: 'lead-08',
    name: 'Sofia Rossi',
    company: 'Aura Estate',
    email: 'sofia@example.com',
    service: 'AI Agents',
    source: 'Direct',
    landingPage: '/ru/services/ai-agents',
    status: 'Lost',
    created: '02 Sep 2026',
    message: 'Interested but budget on hold this quarter.',
    referrer: '—',
    utmSource: '—',
    utmMedium: '—',
    utmCampaign: '—',
    locale: 'en-US',
    notes: 'Revisit in Q4.',
    activity: [
      { date: '01 Sep', text: 'Lead created' },
      { date: '02 Sep', text: 'Status changed: New → Lost' },
    ],
  },
]

export const LEAD_STATUSES: LeadStatus[] = [
  'New',
  'In progress',
  'Proposal',
  'Won',
  'Lost',
]

export const crmMetrics = {
  new: leads.filter((l) => l.status === 'New').length,
  inProgress: leads.filter((l) => l.status === 'In progress').length,
  proposal: leads.filter((l) => l.status === 'Proposal').length,
  won: leads.filter((l) => l.status === 'Won').length,
  lost: leads.filter((l) => l.status === 'Lost').length,
  total: leads.length,
}

export const leadSources: { source: Lead['source']; count: number }[] = (
  ['SEO', 'Ads', 'Telegram', 'Direct', 'Referral'] as Lead['source'][]
).map((source) => ({
  source,
  count: leads.filter((l) => l.source === source).length,
}))

export const adminMetrics = {
  activeProjects: projects.length,
  seoPages: projects.reduce((s, p) => s + p.pages, 0),
  keywords: projects.reduce((s, p) => s + p.keywords, 0),
  newLeads: leads.filter((l) => l.status === 'New').length,
  openLeads: leads.filter(
    (l) => l.status !== 'Won' && l.status !== 'Lost',
  ).length,
}

export const recentActivity: { module: ModuleKey; text: string; time: string }[] = [
  { module: 'SEO', text: '5 SEO pages discovered', time: '2h ago' },
  { module: 'SEO', text: '186 Wordstat keywords imported', time: '5h ago' },
  { module: 'CRM', text: 'New lead from AI Agents page', time: '6h ago' },
  { module: 'CRM', text: 'Lead moved to “In progress”', time: '1d ago' },
  { module: 'SEO', text: 'Keyword mapped to /ru/services/telegram-bots', time: '1d ago' },
]
