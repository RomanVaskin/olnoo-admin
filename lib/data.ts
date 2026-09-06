export type Status =
  | 'Mapped'
  | 'No page'
  | 'Missing'
  | 'Draft'
  | 'Live'
  | 'Synced'
  | 'Pending'

export type Project = {
  id: string
  name: string
  domain: string
  sitemap: string
  pages: number
  keywords: number
  status: 'Synced' | 'Pending'
  lastSync: string
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
    pages: 42,
    keywords: 118,
    status: 'Synced',
    lastSync: '2026-09-05 14:20',
  },
  {
    id: 'insurance',
    name: 'OLNOO Insurance',
    domain: 'insurance.olnoo.com',
    sitemap: '/sitemap.xml',
    pages: 28,
    keywords: 74,
    status: 'Synced',
    lastSync: '2026-09-05 11:02',
  },
  {
    id: 'aura',
    name: 'Aura Estate',
    domain: 'aura.olnoo.com',
    sitemap: '/sitemap.xml',
    pages: 19,
    keywords: 46,
    status: 'Pending',
    lastSync: '2026-09-03 09:48',
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
