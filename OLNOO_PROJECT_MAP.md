# OLNOO Project Map

Этот файл — основной источник истины по runtime-структуре OLNOO.

Перед любой технической задачей по OLNOO Claude/Codex должен сначала прочитать этот файл.
Не искать заново repo/path/service/port, если информация здесь соответствует production.

Если во время задачи подтверждено изменение domain, repo, path, service, port, storage, route или source of truth — обновить этот файл в том же commit.

## 1. OLNOO Main Website

**Domain:**
`https://olnoo.com`

**Repository:**
`https://github.com/RomanVaskin/olnoo`

**Production server:**
KZ VDS

**Production path:**
`/opt/olnoo/projects/olnoo`

**Systemd service:**
`olnoo-web.service`

**Port:**
`3130`

**Technology:**
Next.js 16

**Role:**
Публичный сайт OLNOO.

**Responsibilities:**

- публичные страницы;
- SEO landing pages;
- формы заявок;
- отправка новых лидов в общую CRM.

**CRM:**
Новые лиды пишутся напрямую в общий Postgres CRM через server-side код публичного сайта.

**CRM source of truth:**
Postgres, общий с `olnoo-admin`.
SQLite `data/crm.sqlite` является legacy и не должен использоваться для новых CRM-лидов.

**Admin redirect:**
`/admin/crm`
→ `https://admin.olnoo.com/en?screen=crm-leads&project=olnoo`

## 2. OLNOO Admin

**Domain:**
`https://admin.olnoo.com`

**Repository:**
`https://github.com/RomanVaskin/olnoo-admin`

**Production server:**
KZ VDS

**Production path:**
`/opt/olnoo/projects/olnoo-admin`

**Systemd service:**
`olnoo-admin.service`

**Port:**
`3140`

**Technology:**
Next.js 16.3.3

**Role:**
Единая административная панель OLNOO.

**Main modules:**

- Projects
- CRM
- SEO
- Social
- Ads
- Analytics

**Rule:**
Не создавать отдельные приложения для CRM, SEO, Social, Ads или Analytics без реальной необходимости.

**Предпочтительный путь:**
добавлять новые функции как модули внутри OLNOO Admin.

## 3. CRM

**Admin screens:**

CRM Overview:
`/en?screen=crm-overview&project=<project-slug>`

CRM Leads:
`/en?screen=crm-leads&project=<project-slug>`

**Current production example:**
`project=olnoo`

**Source of truth:**
Postgres.

**Main table:**
`leads`

**Project relation:**
каждый лид связан с Project.

**Project selection:**
через `project=<project-slug>`.

**Current working flow:**
`olnoo.com contact form`
→ `Postgres leads`
→ `project=olnoo`
→ `OLNOO Admin CRM Leads`
→ `OLNOO Admin CRM Overview`

**CRM rules:**

- Postgres — единственный актуальный source of truth для новых лидов.
- SQLite не использовать для новых лидов.
- Не создавать вторую CRM-БД.
- Не создавать отдельные mock CRM данные в Admin.
- `crm-overview` и `crm-leads` должны читать одни и те же реальные данные.
- Lead нельзя переносить между Projects через обычное редактирование.
- Notes и status сохраняются в Postgres.
- После reload изменения должны сохраняться.

**Current migration:**
`db/migrations/0004_crm_leads.sql`

**Production migration applied:**
Yes.

## 4. SEO

**Location:**
OLNOO Admin.

**Relationship:**
`Client → Project → SEO`

**Rules:**

- один SEO intent = одна страница;
- не создавать thin pages под синонимы;
- публичный сайт должен иметь sitemap;
- SEO Create/Improve используют весь cluster;
- обязательны CTA и internal links;
- использовать Quality Gate;
- новый Project должен автоматически попадать в общие SEO проверки;
- SEO должен быть привязан к Project, а не существовать отдельно.

SEO изменения не должны создавать отдельные CRM или Project сущности.

## 5. Social

**Status:**
Следующий модуль для развития.

**Location:**
OLNOO Admin.

**Required relationship:**
`Client → Project → Social`

Social должен использовать существующий Project.

Если Social создаёт лиды или потенциальные контакты:
использовать существующую CRM, а не отдельное хранилище.

Не создавать отдельный Social application без необходимости.

## 6. Ads

**Location:**
OLNOO Admin.

**Required relationship:**
`Client → Project → Ads`

Ads должен использовать существующий Project.

Будущие рекламные лиды должны попадать в общую CRM.

Не создавать отдельную CRM для Ads.

## 7. Analytics

**Location:**
OLNOO Admin.

**Required relationship:**
`Client → Project → Analytics`

Analytics должен агрегировать данные существующих модулей, а не создавать параллельные сущности.

**Основная цель:**
показывать результаты Project по каналам:

- SEO
- CRM
- Social
- Ads

## 8. Main OLNOO relationship

**Главная структура:**

`Client`
→ `Project`
→ `SEO`
→ `CRM`
→ `Social`
→ `Ads`
→ `Analytics`

Project — основной связующий объект между модулями.

Один Client может иметь несколько Projects.

Новый Project должен по возможности автоматически становиться доступным всем общим модулям.

## 9. Production rules

**Перед изменениями:**

1. Определить, какой repo относится к задаче по этой карте.
2. Работать только в нужном repo.
3. Проверить `git status`.
4. Не трогать чужие незакоммиченные изменения.
5. Не менять nginx/systemd/GitHub Actions без необходимости.
6. Не создавать новую БД или сервис, если задача решается существующим модулем.
7. Не хранить secrets и тяжёлые media в Git.

**После изменений:**

1. build;
2. typecheck, если используется;
3. минимальная функциональная проверка;
4. production E2E для критических пользовательских потоков;
5. обновить этот файл, если изменилась архитектура/runtime;
6. commit;
7. push только в правильный repository.

## 10. Agent execution rule

Claude/Codex не должен заставлять пользователя вручную переносить результаты между Terminal и агентом, если агент сам имеет доступ к нужному инструменту.

Не устраивать длинные диагностические циклы.

**Рабочий порядок:**
`problem → minimal fix → verification`

Диагностика допускается только если без неё невозможно безопасно выполнить исправление.

Не повторять уже выполненные проверки.

**Не угадывать:**

- repo;
- path;
- service;
- port;
- database;
- source of truth.

Если эти данные уже подтверждены в этом документе — использовать их.
