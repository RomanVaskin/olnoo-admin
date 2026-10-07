# SEO-модуль OLNOO (SEO_AGENT)

Единственный source of truth по SEO в OLNOO: цель, принципы, архитектура, фактический статус и roadmap. `AGENTS.md`, `OLNOO_ARCHITECTURE.md` и `OLNOO_PROJECT_MAP.md` ссылаются сюда и не дублируют это содержание.

- **Решение: вариант C — минимальный SEO-модуль + read-only SEO Observer**, без отдельной агентной архитектуры. Зафиксировано 2026-10-07 по итогам архитектурного ревью.
- Раздел «Текущий статус» сверен с кодом ветки `main` на коммите `4e782a1` (2026-10-07). Прод и БД при сверке не проверялись.
- Любое изменение фактов SEO-пайплайна фиксируется здесь в том же коммите (правило «Change rule» из `OLNOO_ARCHITECTURE.md`).
- Подробный справочник текущей реализации (импорт Wordstat, pages sync, кластеризация, очистка запросов) — в конце файла, раздел «Справочник реализации».

## 1. Цель

SEO в OLNOO — reusable-модуль для проектов и клиентов (`Client → Project → SEO`).

Он должен:

- получать семантику;
- фильтровать нерелевантные запросы;
- группировать запросы по intent;
- связывать intent с существующей страницей или с новой страницей;
- формировать задачу Improve/Create;
- передавать её Claude/Developer;
- после публикации отслеживать индексацию и поисковый результат;
- работать RU и EN;
- поддерживать сначала Yandex, затем Google — без второго отдельного SEO Agent;
- учитывать видимость в AI-ответах (Алиса AI, Google AI Overviews / AI Mode, ChatGPT и др.) в рамках того же модуля и того же Observer — см. раздел 8a.

**Не строим** отдельные SEO Agent / Content Agent / Developer Agent / Orchestrator без реальной необходимости. Роль Content + Developer сейчас выполняет Claude Code по сформированной задаче, роль Orchestrator — существующий `lib/seo-pipeline.ts` (два шага в одном запуске).

## 2. Принципы

- **Не усложнять.** Сначала простейшее рабочее решение. Новая сущность, слой, статус, AI-вызов или ручной шаг добавляется только при реальной необходимости.
- **Один SEO intent = одна страница.** Не создавать страницу под каждый ключ, thin pages под синонимы и thin city pages без отдельного локального intent.
- Одна сильная страница может покрывать несколько близких confirmed clusters.
- **Секции строятся по смысловым sub-intents, а не под каждый синоним** и не под каждый кластер.
- Primary keyword — основной запрос страницы. Secondary keywords покрываются естественно: Title, Description, H1, H2/H3, текст, FAQ, коммерческие блоки. Без keyword stuffing, без механической вставки каждого long-tail.
- **Семантика не является источником бизнес-фактов.** Запрос в кластере не делает услугу, город, цену, бренд или аудиторию существующими у бизнеса.
- **Factual guardrail обязателен для Improve и Create.** Нельзя выдумывать клиентов, кейсы, цифры, результаты, партнёров, сертификаты, награды, опыт; неподтверждённое утверждение переписывается нейтрально или не добавляется. (Сейчас guardrail есть только в Improve — см. «Текущий статус».)
- **AI-рекомендация не равна подтверждению человека.** Если AI нашёл страницу: Recommend → Confirm → или Find another. Если AI сказал «страницы нет»: No page → Create page → или Find existing. Выбор страницы — поиск по URL/title/H1, а не огромный dropdown.
- **CTA и internal links используют существующий flow проекта:** не создавать новую форму, если рабочая уже есть; не отправлять пользователя на главную без причины; не менять рабочую отправку заявок. Для `olnoo.com`: использовать существующий contact / ProjectRequest flow и не менять рабочий Resend/email flow без необходимости.
- **Coverage Check и Quality Gate остаются частью prompt и PR review**, а не отдельными сущностями БД. Их результат (`SEO COVERAGE`, `QUALITY GATE`) проверяет человек в финальном отчёте Claude и при review PR.
- **GitHub — source of truth для изменений сайта.** Claude Code **вручную** создаёт PR; PR-автоматизацию пока не строим.
- Новая страница создаётся только когда нужен отдельный intent и среди существующих страниц нет подходящей.
- Ничего в SEO не меняется автоматически без подтверждения человека. SEO Observer только читает.

Текст задач для Claude (SEO RULE, CTA, INTERNAL LINKS, COVERAGE CHECK, CONTENT QUALITY GATE, BUSINESS FACTS) живёт в коде: `lib/seo-task-generator.ts`, а не в этом документе, чтобы не расходиться с кодом. Prompt Create защищён golden-хэшами в `lib/improve-page-task.test.ts`: его изменение требует осознанного обновления хэшей.

## 3. Минимальная архитектура

```
Wordstat / semantic source
→ relevance
→ clustering
→ human review
→ confirmed cluster → page
→ Improve / Create
→ Claude
→ PR
→ sitemap/pages sync
→ SEO Observer
→ indexing + search performance
→ before/after comparison
```

Где это находится сейчас:

| Шаг | Где | Статус |
|---|---|---|
| Wordstat / semantic source | `lib/keywords-import.ts`, `app/api/keywords/import`, экран `seo-wordstat` | работает, ручная загрузка CSV/XLSX |
| relevance | `lib/keywords-relevance.ts`, `lib/keywords-relevance-rules.ts`, `app/api/keywords/relevance` | работает, заморожен |
| clustering | `lib/seo-clustering.ts`, `lib/seo-clustering-batch.ts`, `lib/seo-pipeline.ts` | работает |
| human review | `updateClusterReview` в `lib/seo-clustering.ts`, `PATCH /api/seo-clusters` | работает |
| confirmed cluster → page | `seo_clusters.confirmed_page_id` | работает |
| Improve / Create | `lib/improve-page-task.ts`, `lib/seo-task-generator.ts`, панель задачи в `components/sections/seo-clusters.tsx` | работает как генерация текста задачи; страница автоматически не создаётся |
| Claude → PR | вне Admin, вручную | ручной шаг |
| sitemap/pages sync | `lib/sitemap.ts`, `lib/html-extract.ts`, `app/api/pages/sync` | работает |
| SEO Observer | — | не реализован |
| before/after | — | не реализован |

До подтверждения человеком выполняется два AI-прохода: relevance и clustering. Решение «страница есть / страницы нет» принимается в clustering (см. раздел 5). Сильная модель нужна только для итогового текста Improve/Create в Claude Code.

## 4. Что остаётся (KEEP)

- **keywords import** — `lib/keywords-import.ts`, `lib/import-parse.ts`, `lib/wordstat-import-rules.ts`, `lib/wordstat-upload.ts`, `lib/keywords-delete.ts`.
- **relevance classification — заморозить.** Новые режимы перепроверки, правила и пороги не добавлять; правки только по реальной подтверждённой причине. Инварианты relevance, кластеризации и импорта (NULL = «не проверено» и это не `uncertain`; ручные решения AI не перезаписывает; clustering читает актуальный статус; human-reviewed кластеры сохраняются при перезапуске; импорт = один batch) описаны в «Справочнике реализации».
- **clustering как ядро** — `lib/seo-clustering.ts`, `lib/seo-clustering-batch.ts`.
- **`review_status`** — `pending | confirmed | no_page | ignored`.
- **`confirmed_page_id` — единственный source of truth «кластер → страница».**
- **Aggregation всех confirmed clusters страницы для Improve** — `lib/improve-page-task.ts` (`clustersConfirmedForPage`, `buildImproveTaskForPage`), тесты `lib/improve-page-task.test.ts`. Выборка: `review_status = confirmed` и `confirmed_page_id = page.id`; одна задача на страницу; кластеры с `intent = navigational` привязаны к странице для аналитики, но в обязательное покрытие не входят.
- **pages sync** — `lib/sitemap.ts`, `lib/html-extract.ts`, `lib/fetch-retry.ts`, `app/api/pages/sync`.
- **factual guardrails** — `businessFactsGuardBlock` в `lib/seo-task-generator.ts`.
- **internal links rules** — `internalLinksRuleBlock` там же.
- **existing `lib/seo-pipeline.ts`** — не расширять до orchestrator.

## 5. Что упрощаем

- **Отдельный AI review CREATE / IMPROVE / IGNORE объединить с clustering.** Сейчас это второй AI-проход (`lib/seo-cluster-review.ts`, `app/api/seo-clusters/review`, миграция `0014_cluster_ai_review.sql`), который переписывает те же колонки, что уже заполняет clustering (`status`, `recommended_page_id`, `needs_new_page`, `reason`). Clustering уже умеет возвращать рекомендованную страницу и статус `Ignored`.
- **AI merge кластеров не развивать сверх необходимого:** максимум один проход, после проверки на benchmark (`seo-benchmark-driveset-3providers.mts`, в репозитории на момент написания его нет). Инвариант остаётся: один intent не должен распадаться на несколько кластеров из-за границ батчей.
- **Sitemap health и pages sync объединены (PR1):** один resolver и один читатель sitemap (см. «Текущий статус»).
- **CTA rule сделать project-agnostic:** убрать из `ctaRuleBlock` блок «Специально для этого проекта», который описывает контактную форму olnoo.com, но попадает в задачи любого проекта.
- **Create получает тот же factual guardrail, что Improve.**

## 6. Что не развиваем / планируем удалить

- **SEO Map / `keyword_pages` как второй source of truth.** Сейчас `keyword_pages` пишет только SEO Map (`app/api/seo-map`), а читают его SEO Map, Keywords API (`app/api/keywords/route.ts`) и `lib/keywords-delete.ts` (блокирует удаление связанных ключей).
- **`keywords.cluster`.** Колонка текстовая; записи в неё в коде на `4e782a1` не найдено, читают её SEO Map и Keywords API.
- **Отдельные `ai_decision` / `suggested_slug` / `suggested_h1` / `suggested_title`** (миграция `0014`), если после проверки production они не нужны. Предложение slug/H1/Title лишнее: задача Create и так просит Claude предложить URL.
- Отдельные **Content Agent / Developer Agent**.
- **Orchestrator.**
- **Finding / Recommendation / Action / Result** как отдельная архитектура. Достаточно кластера со статусами и одной таблицы изменений страниц (шаг 6 в разделе 12); Result вычисляется из двух срезов Observer и не хранится.
- **PR automation.**
- **Хранение Coverage / Quality Gate в БД.**

**ВАЖНО: удаление legacy-сущностей выполняется только после проверки production data. Ни одна из перечисленных сущностей на момент написания документа не удалена и продолжает существовать в коде и схеме.**

## 7. RU + EN

SEO pipeline должен быть language-agnostic. Язык, рынок и регион — свойства **Project SEO Context** (`project_seo_context`), а не отдельные ветки бизнес-логики. Веток вида `if ru … / if en …` не создавать.

План:

- `languages` хранится в Project SEO Context;
- если страница существует — используется её locale (`pages.locale`, его заполняет pages sync);
- если создаётся новая страница и у проекта несколько языков — clustering возвращает `language`;
- структура URL определяется существующей структурой проекта;
- не требовать автоматически `/ru/` или `/en/`.

Что зашито сейчас и подлежит исправлению (шаг 4 в разделе 12):

- `lib/seo-task-generator.ts`: тип языка только `ru | en`; задача Create требует URL вида `/ru/...` или `/en/...`. У DriveSet страницы без префикса (например `/polirovka-avto`).
- `lib/cluster-pages.ts`: фиксированный список префиксов `ru, en, kk, kz`; язык кластера без рекомендованной страницы угадывается по кириллице в primary keyword.
- `project_seo_context` хранит регион, но не язык.

## 8. Yandex + Google

**Не делать два SEO Agent. Один SEO Observer, разные источники данных.**

- v1: Yandex Webmaster; Yandex Metrica — органический трафик по страницам.
- v2: Google Search Console.

Нормализованные данные (различия провайдеров закрываются на уровне connector, не в бизнес-логике SEO):

**Query metrics:** `provider`, `date_from`, `date_to`, `query`, `url` (nullable), `impressions`, `clicks`, `ctr`, `position`.

**Page metrics:** `provider`, date range, `url`, `traffic`, `source`.

**Indexing:** `provider`, `url`, `indexed`, `status/reason`, `checked_at`.

Ограничения источников (по официальной документации, проверено 2026-10-07):

- **Yandex Webmaster, популярные запросы** отдают показы, клики, среднюю позицию показа и клика; CTR не отдаётся, данные только по запросам и **без разреза по URL**. Поэтому для Yandex `url` в query metrics = `NULL`, `ctr` считается в connector как `clicks / impressions`, а трафик по страницам берётся из Метрики (поле `source` показывает происхождение; визиты не равны кликам).
- **Yandex Webmaster, важные страницы** отдают по каждому URL код ответа, присутствие в поиске, причины исключения — но только для URL, которые владелец добавил в мониторинг в Webmaster.
- **Google Search Console** для индексации URL предоставляет URL Inspection API с квотой 2000 запросов в сутки и 600 в минуту на сайт; поисковая статистика — Search Analytics API (измерения page и query — по общему знанию API, в проверенной выдержке документации не подтверждены).

Не вводить adapter/interface abstraction заранее. Abstraction добавляется только при второй реальной интеграции (то же правило, что для Ads Agent в `OLNOO_ARCHITECTURE.md`).

Источники: [Yandex: популярные запросы](https://yandex.com/dev/webmaster/doc/en/reference/host-search-queries-popular.md), [Yandex: важные страницы](https://yandex.com/dev/webmaster/doc/en/reference/host-id-important-urls), [Google Search Console API: лимиты](https://developers.google.com/webmaster-tools/limits).

## 8a. Search + AI Visibility

**Одна система, не две.** AI Visibility — это (1) несколько пунктов в существующем Quality Gate и (2) ещё источники данных в том же SEO Observer. Отдельный GEO / AEO / AI-Search Agent, отдельный orchestrator, новые таблицы, сервисы и provider abstraction не создаются. Правило «один intent = одна страница» действует без изменений. Язык, рынок и регион берутся из Project SEO Context (раздел 7); отдельной архитектуры для RU и EN нет.

**Что подтверждено официальной документацией (проверено 2026-10-07):**

- **Google:** «There are no additional requirements to appear in AI Overviews or AI Mode, nor other special optimizations necessary»; новые machine-readable / AI-text файлы и особая schema.org-разметка не нужны. Нужна обычная индексация и возможность показывать сниппет. Показы из AI-фич входят в общие данные отчёта Performance. ([AI features and your website](https://developers.google.com/search/docs/appearance/ai-features))
- **Google Search Console, Generative AI performance report (Search):** только показы (impressions) ссылок в AI Overviews и AI Mode, разрезы page / country / date / device. Клики и запросы в нём не отдаются; данные с 2026-08-31; доступ раскатывается постепенно и зависит от числа показов; в справке про API не сказано. ([справка](https://support.google.com/webmasters/answer/16984139?hl=en))
- **Яндекс Вебмастер, «Видимость сайта в Алисе AI»:** Share of Voice (доля запросов с упоминанием сайта среди запросов, на которые отвечала Алиса AI), частота упоминаний в диапазонах топ-3 / топ-10 / топ-20, динамика, примеры запросов с упоминанием и без, примеры конкурентов; данные за 3 месяца, обновление раз в неделю; только для подтверждённых сайтов, которые достаточно часто показываются в Поиске на высоких позициях. Кликов и показов нет, API в документации не упомянут. ([справка](https://yandex.ru/support/webmaster/ru/service/alice-answers))
- **OpenAI:** появление в поиске ChatGPT определяет OAI-SearchBot (управляется через robots.txt); GPTBot — обучение моделей, на поиск не влияет; ChatGPT-User — действия пользователя, robots.txt может не применяться. ([OpenAI crawlers](https://developers.openai.com/docs/bots))
- **API для прогонов вопросов:** OpenAI Responses API с инструментом `web_search` возвращает `url_citation` и принимает `user_location`; поиск тарифицируется отдельно. Документация не сравнивает результат API с интерфейсом ChatGPT. Для Gemini (grounding) и Perplexity (Sonar) официальная документация в этой проверке не сверялась — при реализации проверить. ([OpenAI web search](https://developers.openai.com/api/docs/guides/tools-web-search.md))

**Что измеряем (надёжно):**

| Показатель | Источник | Статус |
|---|---|---|
| Показы страниц в AI Overviews / AI Mode | Google Search Console | v2, вместе с GSC |
| Share of Voice, примеры запросов, конкуренты в Алисе AI | Яндекс Вебмастер | v2, ручной срез (API не подтверждён) |
| Индексация и доступность страниц; открыт ли OAI-SearchBot | Observer, robots.txt | v1 / v2 |
| Доля прогонов, где бренд или страница упомянуты, на фиксированном наборе вопросов | ручной набор вопросов | v2, не KPI (см. ниже) |

**Чего НЕ считаем надёжной метрикой:**

- **Позиция бренда в AI-ответе, «AI visibility score», тональность** — не вводим. Ответы недетерминированы: по исследованию SparkToro / Gumshoe (≈3000 прогонов, 12 запросов) идентичный список повторяется реже 1 раза из 100, порядок — реже 1 из 1000; устойчивой оказывается только доля прогонов с присутствием бренда.
- **Один прогон одного вопроса** — не измерение.
- **Трафик из AI.** Google не разделяет клики AI-фич и обычного поиска (клики в GSC общие); Яндекс клики Алисы AI не отдаёт. Упоминание или цитата не равны визиту.
- **Сравнение API-ответа с тем, что видит пользователь.** Результат зависит от аккаунта, региона, персонализации, времени и версии модели; у API и интерфейса он может отличаться.
- **Hard KPI.** AI-показатели используются как сигнал для Improve/Create, а не как цель или отчётность перед клиентом.

**Показатели Observer: KEEP / LATER / REMOVE**

| Показатель | Решение | Почему |
|---|---|---|
| Упоминается ли бренд (доля прогонов k из N) | KEEP, v2 | единственная относительно устойчивая метрика из прогонов |
| По каким вопросам бренда нет | KEEP, v2 | основной вход для findings → Improve/Create |
| Какие конкуренты упоминаются | KEEP, v2 | в Яндексе есть официально; в прогонах — как наблюдение |
| Какие сайты и страницы цитируются | KEEP, v2, наблюдение | URL-цитаты из API есть; это не KPI |
| Factual / content gaps | KEEP, v2 | вывод человека или Claude по findings, а не метрика |
| «Рекомендуется ли бренд» | LATER | сильно зависит от формулировки вопроса; пока входит в «упоминается» |
| AI-клики и трафик из AI | LATER | надёжной атрибуции в проверенных источниках нет |
| Позиция в ответе, score, тональность | REMOVE | нестабильно, псевдоаналитика |

**Набор вопросов (ручной MVP).** 10–30 вопросов проекта, сформированных из подтверждённых intents и Project SEO Context (язык, рынок, регион). Каждый вопрос прогоняется не менее 5 раз через доступный API (предпочтительно) или вручную; записываются дата, система / модель, регион и язык, результат (упомянут / не упомянут, цитируемые URL, конкуренты). До/после сравнивается только на том же наборе вопросов. Browser automation не используется; ограничения и условия использования систем не обходятся. Отдельную таблицу под это не вводим: до реализации Observer результат хранится как обычный ручной срез; где он хранится в v2 — решается при реализации Observer.

**AI/GEO Quality Gate.** Это пункты внутри существующего Quality Gate (проверка в prompt и при review PR), а не отдельный процесс и не сущность БД:

- компания, услуга и регион / зона обслуживания названы на странице однозначно (кто, что, где);
- цены — только подтверждённые, с условиями; иначе без цифр;
- на частые вопросы есть прямой короткий ответ (1–3 предложения) в начале секции, затем детали; секцию можно прочитать отдельно от страницы;
- секции построены по смысловым sub-intents (H2/H3), без дублирования одного intent на нескольких страницах;
- сущности и факты не противоречат другим страницам проекта; есть internal links на связанные страницы;
- schema.org — только тип, соответствующий видимому содержимому страницы, и только где уместно (для попадания в AI-фичи Google она не требуется);
- нет выдуманных фактов (factual guardrail, раздел 2);
- страница индексируема и не закрыта от нужных краулеров (для поиска ChatGPT — OAI-SearchBot в robots.txt); решение о GPTBot принимает владелец проекта.

Сейчас `contentQualityGateBlock` в `lib/seo-task-generator.ts` этих пунктов не содержит; добавление — часть prompt/language patch (шаг 4 в разделе 12).

**AI finding → Improve / Create.**

- Вопросы и prompts сами кластерами и страницами не становятся. Finding («по вопросу X бренда нет») сопоставляется с подтверждённым кластером или существующей страницей.
- Несколько близких вопросов усиливают одну существующую страницу (секция, прямой ответ, FAQ) — рекомендация **IMPROVE**.
- **CREATE** рекомендуется только если есть отдельный устойчивый intent и существующая страница его не покрывает.
- Решение подтверждает человек. Автоматическое создание страниц под вопросы в текущий план не входит; автономность — только после доказанной стабильности (Later).

**Не делаем:** отдельный GEO / AEO / AI-Search Agent, orchestrator, новые таблицы и сервисы, provider abstraction до второй реальной интеграции, browser automation, `llms.txt` и другие «AI-файлы» (для AI Overviews / AI Mode Google прямо пишет, что они не нужны), автоматические прогоны по расписанию, автосоздание страниц.

## 9. SEO Agent v1

MVP:

```
Import
→ relevance
→ clustering
→ human confirmation
→ Improve/Create
→ Claude
→ PR
→ Yandex SEO Observer
→ manual snapshot
→ before/after
```

- Observer **read-only**.
- Срез («Снять срез») делается вручную: нормализованные строки записываются с датой и провайдером; результат «до/после» вычисляется как разница двух срезов вокруг даты изменения страницы.
- Никаких автоматических изменений SEO без подтверждения человека.
- AI Visibility в v1 ограничивается AI/GEO-пунктами Quality Gate (раздел 8a); измерений AI в v1 нет.

## 10. SEO Agent v2 и Later

**v2:**

- Google Search Console (включая Generative AI performance report — только показы, раздел 8a);
- Яндекс Вебмастер «Видимость сайта в Алисе AI» — ручной срез;
- небольшой ручной AI Visibility Observer: 10–30 вопросов проекта, несколько прогонов, доля упоминаний (раздел 8a);
- EN / multilingual projects.

**Later:**

- scheduled snapshots и автоматические прогоны AI-вопросов по расписанию;
- рекомендации «какую страницу улучшать следующей»;
- широкая multi-provider аналитика AI visibility, автоматический ingest, если появится подтверждённый API;
- автономный Improve/Create — только после доказанной стабильности;
- автоматизация PR — только при реальном повторяющемся объёме.

## 11. Текущий статус

Сверено с кодом `main` на коммите `4e782a1`.

**WORKS**

- semantic import (Wordstat CSV/XLSX, batch, удаление импорта);
- relevance;
- clustering (батчи + merge по intent);
- human review;
- `confirmed_page_id`;
- Improve;
- aggregation всех confirmed clusters одной страницы (тесты `lib/improve-page-task.test.ts`, `lib/cluster-decision.test.ts`, `lib/cluster-pages.test.ts` — 23 теста — проходят);
- Create/Improve prompt generation (генерируется текст задачи; страница автоматически не создаётся);
- pages sync;
- Technical SEO preflight (PR1): экран Technical SEO (`seo-health`, `GET /api/seo-health`, логика `lib/seo-health.ts`) для каждого проекта из таблицы `projects` с domain проверяет сайт (HTTP), `robots.txt` (есть/нет, `Disallow: /` для `User-agent: *`), sitemap (статус, число URL) и каждый URL из sitemap (до 100 за проверку; HTTP, canonical, index/noindex, Title, H1). Severity: ERROR — сайт недоступен, sitemap отсутствует/нечитаем, URL 4xx/5xx/недоступен, noindex при URL в sitemap, `Disallow: /`; WARNING — нет robots.txt (или не читается), нет/чужой canonical, нет Title/H1, редирект. Проверка по открытию экрана и кнопке «Проверить все», не по расписанию, результат не хранится.
- AI review CREATE/IMPROVE/IGNORE — работает как отдельный проход (подлежит объединению с clustering, раздел 5).
- SEO Map / `keyword_pages` — работает как legacy (не развивать, раздел 6).

**PARTIAL**

- CTA rules — только инструкция в задаче; содержит блок «Специально для этого проекта», который попадает в задачи любого проекта.
- internal links — только инструкция в задаче.
- factual guardrail — только Improve; в Create нет.
- Coverage Check — только инструкция в задаче; результат не сохраняется и не проверяется кодом.
- Quality Gate — то же; AI/GEO-пунктов (раздел 8a) в нём пока нет.
- sitemap: один источник — `resolveSitemapUrl` в `lib/sitemap.ts` (`projects.sitemap_url`, иначе единственный fallback `domain + /sitemap.xml`) и один читатель `readSitemap`; им пользуются и Pages sync (`fetchSitemapUrls`), и Technical SEO. Число URL — страницы (index-файлы разворачиваются на один уровень, до 20 sitemap). Проверка не по расписанию, результат не сохраняется; Core Web Vitals, schema.org, контент, индексация и AI visibility не проверяются.
- язык — зашит `ru | en`: задача Create требует `/ru/` или `/en/`; язык кластера без рекомендованной страницы определяется по кириллице.

**NOT IMPLEMENTED**

- Yandex Webmaster integration;
- Google Search Console;
- SEO Observer;
- AI Visibility (отчёт GSC по AI-фичам, Алиса AI в Вебмастере, набор AI-вопросов);
- indexing tracking;
- before/after tracking;
- PR tracking.

Интеграций с Yandex Webmaster и Google Search Console в коде нет. Yandex Metrika в репозитории подключена только как read-only Observer агрегатов для Ads (`/api/metrika/observer`), к SEO она не привязана.

Статус миграций SEO в production (`0012`, `0013`, `0014`) записан в «Справочнике реализации» и перед использованием должен быть перепроверен.

## 12. Следующие шаги

Порядок фиксированный.

1. **Реальный end-to-end Improve DriveSet:** `/polirovka-avto` или `/okleyka-avto` → prompt → Claude → PR → проверка результата.
2. **Проверить production data перед удалением legacy:**
   - `count(*)` в `keyword_pages`;
   - используется ли SEO Map;
   - как часто человек меняет AI review decision.
3. **Cleanup:**
   - убрать второй source of truth (SEO Map / `keyword_pages` / `keywords.cluster`);
   - убрать отдельный AI review;
   - не смешивать с другими изменениями.
4. **Prompt/language patch:**
   - factual guardrail в Create;
   - neutral CTA;
   - язык из Project SEO Context;
   - убрать hardcoded `/ru/` `/en/`;
   - AI/GEO-пункты в `contentQualityGateBlock` (раздел 8a).
5. **SEO Observer v1:**
   - Yandex Webmaster;
   - organic page traffic из Metrika;
   - manual snapshot.
6. **Минимальный tracking изменений:** `page_id` + дата + PR URL + cluster ids/notes.
7. **После стабилизации:** Google Search Console + multilingual support + ручной AI Visibility Observer (раздел 8a); scheduled snapshots — позже.

## 13. Владение документацией

- **`docs/SEO_AGENT.md`** — единственный source of truth по SEO: цель, принципы, pipeline, статус, roadmap, справочник реализации.
- **`OLNOO_PROJECT_MAP.md`** — короткий статус SEO и ссылка сюда; общие production-факты (домены, сервисы, порты, БД) остаются там.
- **`OLNOO_ARCHITECTURE.md`** — только основные архитектурные принципы SEO и ссылка сюда.
- **`AGENTS.md`** — `docs/SEO_AGENT.md` в «Read first» для SEO-задач; общие правила для сайтов всех проектов (один intent = одна страница, sitemap, не выдумывать факты) остаются там.
- Длинный текст не копируется в несколько файлов. Изменился факт SEO-пайплайна — правится этот документ в том же коммите.

Решено: для нового публичного сайта `robots.txt` — обязательный базовый technical SEO минимум (Next.js: стандартный путь `app/robots.ts`; сложная ручная конфигурация не требуется), sitemap тоже обязателен. Единое правило — в `README.md` («New project standard») и `AGENTS.md`.

---

## Справочник реализации

Перенесён из `OLNOO_PROJECT_MAP.md` без изменения текста. Правок две: уровень заголовков повышен на один (`##` → `###`), ссылка на раздел AI Router получила имя файла. Описывает код на коммите `4e782a1`. Где справочник расходится с решением C (отдельный AI review, Create без guardrail, язык ru/en, SEO Map), действует решение C из разделов 4–7; справочник обновляется вместе с кодом.

### SEO → Import Wordstat

Screen `?screen=seo-wordstat` (`components/sections/wordstat-import.tsx`). APIs: `GET/POST /api/keywords/import` (`app/api/keywords/import/route.ts`) and `POST /api/keywords/import/delete` (`app/api/keywords/import/delete/route.ts`). Logic: parsing `lib/import-parse.ts`, upload limits/merge rules `lib/wordstat-import-rules.ts` (shared by UI and API), upload reading `lib/wordstat-upload.ts`, batches/history `lib/keywords-import.ts`, import deletion `lib/keywords-delete.ts`. Tables: `keywords` (unique `project_id, query, region`), `imports` (one log row per file), and since `db/migrations/0011_import_batches.sql`: `import_batches` (one row per operation), `imports.batch_id`, `import_batch_keywords` (query, region, frequency, `created` — exactly which keywords a batch brought and whether it created them). `import_batches.kind`/`source_project_id` are left over from a removed transfer feature: every new batch is `kind='import'`.

- **Selection.** Click opens the picker (`multiple`, `.csv,.xlsx`); drag & drop is handled on the dropzone plus a window-level guard. Each file is parsed by its own small preview request (4 in parallel), results are keyed by file, so files can be added at any time — earlier the second drop was silently ignored while the first preview ran, which is why ~20 files had to be imported in two parts. The UI shows per file: rows or parse error, size; total: «N файлов · X MB · Y уникальных ключевых слов».
- **Limits (one import request):** 30 files, 5 MB per file, 10 MB total — checked in the UI before sending and again on the server (413 with «31 файл · 18.4 MB. Максимум 30 файлов и 10.0 MB…»). A non-JSON answer from a proxy (e.g. nginx `413 Request Entity Too Large`) is shown as a readable message instead of a JSON error. nginx `client_max_body_size` on `admin.olnoo.com` is not recorded here — must be ≥ 10m for a full 30-file batch (unconfirmed).
- **Import = one batch, one transaction:** rows of all files merged by `(keyword, region)` (highest frequency wins), one set-based upsert (`INSERT … SELECT unnest … ON CONFLICT DO UPDATE`, existing keywords get frequency/`updated_at`, never duplicated), batch + `import_batch_keywords` + one `imports` row per file. Any error rolls the whole batch back. Unknown project → 400.
- **History:** grouped by operation, 10 per page («Показать ещё»), expandable file list. Imports with status `Deleted` are hidden by default (rows stay in the DB) and shown with the «Показать удалённые» toggle (`GET /api/keywords/import?includeDeleted=1`). Pre-batch imports (`imports.batch_id IS NULL`) are grouped by their transaction timestamp and labelled «до batch-учёта».
- **«Удалить импорт»** (history action, batches and pre-batch groups) — the way to fix an import into the wrong project: delete it, then import the original files into the right project. A preview is mandatory (project, date, files, keywords of the import; will be deleted / existed before / linked to SEO / not found); confirm runs one transaction that deletes **only** keywords proven to be created by that import and not referenced by `seo_cluster_keywords`, `keyword_pages` or `seo_clusters.primary_keyword_id`, then marks the import `Deleted` (it stays in history). Proof: batch — `import_batch_keywords.created` and `keywords.created_at = import_batches.created_at`; pre-batch group — `keywords.created_at` = the import transaction timestamp (keywords and log rows were written in one transaction; `now()` is the transaction start). Keywords that existed before stay (their frequency was overwritten and cannot be restored); «Не найдено» is unknown («—») for pre-batch groups. A keyword created by an earlier import of the same mistake and only updated by a later one counts as «существовали раньше» for the later one and is deleted with the earlier one. A deleted import cannot be deleted again.
- **Read-only diagnostics:** `scripts/wordstat-import-report.sql` (`psql "$DATABASE_URL" -v slug=olnoo -v day=2026-10-02 -v target=driveset -f scripts/wordstat-import-report.sql`) — operations of a day, created keywords, conflicts, links, overlap with another project. Writes nothing.

### Pages sync (sitemap → pages)

`POST /api/pages/sync {projectId}` (`app/api/pages/sync/route.ts`): `lib/sitemap.ts` reads the project's sitemap (index files one level deep), `lib/html-extract.ts` reads title / H1 / description / locale of each page (5 in parallel) and upserts `pages`. Both fetches go through `lib/fetch-retry.ts`: **9 s timeout per attempt and up to 3 attempts** (pause 1 s, 2 s; worst case ≈ 30 s per URL) on network errors, timeouts, HTTP 5xx and 429; a permanent 4xx is not retried (a 4xx sitemap is skipped, a 4xx page counts as `failed`, as before). When all attempts of a sitemap fail the sync answers 502 `Failed to fetch sitemap: <url>: <reason> after 3 attempts` (also logged); a page that fails all attempts is counted in `failed`. A recovered fetch writes `[pages-sync] <url>: ok on attempt N after N-1 failed (last: <reason>)` (`console.warn`) and an exhausted one `[pages-sync] <url>: all 3 attempts failed …` (`console.error`) to journald (`journalctl -u olnoo-admin | grep pages-sync`) — the data for judging how often the path really fails. **This is an application-level workaround, not a fix of the cause:** on 2026-10-03 diagnostics from the Admin server (KZ, 213.155.29.140) to production DriveSet (REG.RU, 194.67.113.146:443) showed random TCP-connect hangs independent of client (curl, fetch, https.request, bare TCP, domain or direct IP with SNI); DNS, proxy and `NODE_OPTIONS` are not involved. The retry applies to **all projects**. No schema or UI change.

### SEO → Clusters (AI clustering)

Screen `?screen=seo-clusters`, UI `components/sections/seo-clusters.tsx`. Logic `lib/seo-clustering.ts` (jobs, AI calls, save), pure helpers `lib/seo-clustering-batch.ts` (batching, stems, merge prompt/parsing). Tables `seo_clusters` (+ human review fields from 0003) and `seo_cluster_keywords`; no schema change for batching. AI calls go through the OLNOO AI Router (`lib/ai-router.ts`, `maxTokens` 12000).

- **One button = one chain** (`lib/seo-pipeline.ts`), started by `POST /api/seo-clusters/generate {projectId, resume?}` (answers 202 at once); the UI polls `GET /api/seo-clusters/generate?projectId=` every 2 s and shows «Шаг 1 из 2 · Проверка запросов» (only when the project has unclassified keywords) → «Шаг 2 из 2 · Кластеризация»: «Обработано X / N», «Batch i / n», merge pass, then «N keywords обработано · N кластеров создано · N keywords требуют проверки» and, if any, «N запросов требуют проверки — не вошли в кластеризацию». Jobs live in memory of the single `olnoo-admin` process (one pipeline per project; its cleanup run is also visible on the cleanup screen): they survive a failed batch, **not** a service restart/deploy — then the run is started again (already cleaned keywords stay saved).
- **Chain rules:** unclassified keywords (`relevance_status IS NULL`) present → the existing cleanup runs first, otherwise clustering starts at once with **no cleanup AI call**. A failed cleanup batch (after retry) stops the chain — nothing is clustered, existing clusters are untouched — with «Продолжить»; resume re-sends only the failed batches, then clustering follows. After a finished cleanup clustering always runs: `uncertain` never blocks it (excluded, count shown); queries the AI skipped stay unclassified, are excluded and reported. Nothing eligible after cleanup → a plain message, not resumable. Manual overrides are untouched by the chain and decide clustering input like any other status.
- **Input keywords (since migration 0012):** chosen from the LIVE `keywords.relevance_status` at the moment a run starts (`CLUSTERING_KEYWORD_FILTER_SQL`, `lib/keywords-relevance-rules.ts`) — see «SEO → Query cleanup». Project never cleaned (`projects.relevance_cleanup_at IS NULL`): every keyword as before, except keywords a person marked irrelevant / other region. Project that uses cleanup: only `target` + `informational`; irrelevant, geo_mismatch, uncertain and not-yet-checked keywords stay out. Existing clusters are not recalculated by cleanup or by a status change; a new run still replaces `pending` clusters as before. The result shows «N запросов исключено очисткой».
- **Batches:** keywords sorted by stem sequence (same phrase family together; all regions of one query text in one batch), 250 keywords / ≤ 20 000 prompt chars per call (the old single call failed above `MAX_PROMPT_CHARS = 90000`: «Too many keywords for clustering in one run»). 2 calls in parallel, each retried once; a batch that still fails (typically an answer too long for the AI to return) is halved and retried, up to 2 times (250 → 125 → 63), and only then counts as failed. The real reason of a failed batch is shown on the screen under the error and written to journald as `[clustering] …` (`olnoo-admin.service`). 5 193 keywords → 21 batch calls. Keywords the AI leaves out get one second-chance batch; whatever is still missing becomes its own «Needs review» cluster — no keyword is lost.
- **Merge by intent:** per-batch clusters are first merged deterministically (same intent + same stem signature of the main keyword, e.g. «оклейки авто» / «авто оклейка»), then by AI: compact cluster summaries in chunks of 120, up to 3 passes with different orderings (main-keyword stems, stem signature, intent + name), chunks of a pass in parallel; the merge prompt equates synonyms/word forms («оклейка авто/автомобиля/машины») and keeps different services, zones, informational vs commercial, cities and brands apart. Merged clusters get the merge answer's name, intent, main keyword and page recommendation; frequency is recomputed from `keywords`.
- **«Найти существующую» / Recommended pages — language rule** (`lib/cluster-pages.ts`, client-side only): a cluster's language comes from its recommended page or the script of its primary keyword; the offered pages are those of the same language **plus language-neutral ones** (no `/ru/`-style prefix and no stored `pages.locale`, e.g. DriveSet's `/polirovka-avto`). A page that is explicitly RU (prefix or locale) never goes to an EN cluster and vice versa.
- **Human decision beats AI in the UI** (`lib/cluster-decision.ts`): for any cluster (pending / no_page / AI `create`) «Найти существующую» searches the project's Pages; choosing one sets `review_status = confirmed` + `confirmed_page_id` (existing PATCH, no schema change), the pill becomes «Есть страница» and «Улучшить страницу» appears. The AI layer (`ai_decision`, `suggested_*`, `status`) is kept as history (row shows «AI: CREATE»), but the CREATE proposal (slug/H1/Title) is hidden once a page is confirmed or the cluster is ignored; human `no_page` / `ignored` also override an AI «Existing page» in the pill. No page is created automatically. The recommended-pages block (row and expanded detail) shows the confirmed page instead of the «Нет страницы» placeholder, and the AI result/reason of a human-decided cluster is labelled «AI ранее: …» (history).
- **Improve task = one per page:** «Улучшить страницу» (any cluster row) collects ALL clusters of the project with `review_status = 'confirmed'` and `confirmed_page_id` = that page (`lib/improve-page-task.ts`) and builds ONE prompt: one existing page URL, «НЕ создавать новую страницу», a block with every cluster (name, primary keyword, intent, total frequency, keywords); SEO RULE / CTA / coverage apply to the combined semantics. One cluster → the classic single-cluster prompt (unchanged). **Content scope:** clusters with `intent = 'navigational'` (third-party brands) stay bound to the page for analytics but are excluded from mandatory coverage — the prompt lists them in a separate «Аналитические кластеры» block (name/intent/frequency only, no keywords) and tells Claude not to cover them; commercial/informational/mixed stay in scope (a future relevance status will refine this). Only navigational clusters on a page → no Improve task (button is a no-op). **Business-facts guardrail:** the Improve prompt (not Create) has a «BUSINESS FACTS / SEMANTIC SAFETY RULE» before SEO RULE — SEO semantics are demand, not business facts; unconfirmed services/cities/audiences/prices/etc. are not added and go to «Intentionally not covered» (not a FAIL), and independent search intents go to «CANDIDATE SEPARATE PAGES» in the final SEO COVERAGE (no page is created). Universal, no project-specific keyword filtering. Create flow is separate and unchanged.
- **Save:** one transaction at the end. Clusters still `review_status = 'pending'` are replaced; **human-reviewed clusters (confirmed / no_page / ignored) are kept with their keywords, are not sent to the AI again, and only receive newly matched keywords** (earlier every run deleted all clusters, reviews included). A failed run changes nothing in the DB; «Продолжить» (`resume: true`) re-sends only failed batches, then merge and save.
- **«AI проверить все кластеры»** (button above the table; `lib/seo-cluster-review.ts`, `POST/GET /api/seo-clusters/review`, in-memory job per project, polled every 2 s; table refreshes while it runs): one decision per cluster — **CREATE** (separate useful intent without a page; slug + H1 + Title proposed, no thin pages for synonyms / micro-geo / one low-frequency query), **IMPROVE** (existing project page, exact url validated against `pages`; generic about/contact/cases pages rejected), **IGNORE** (navigational/junk, duplicate or too-narrow intent; short reason). The prompt carries the WHOLE cluster (up to 15 keywords with frequency, rest counted), the project SEO context and existing pages — no project-specific logic. BULK route only: `SEO_BULK_ROUTE` (deepseek, reasoning off, no fallback), task `seo-cluster-review`, compact output `{"d":[[id,"C",slug,H1,Title,reason],[id,"I",url,reason],[id,"X",reason]]}`, 12 clusters per call, 3 in parallel. **Only prepares decisions — no page is created.** Storage reuses the AI layer: `status` (CREATE → «No page», IMPROVE → «Existing page», IGNORE → «Ignored»), `recommended_page_id`, `needs_new_page`, `reason`; migration `0014_cluster_ai_review.sql` (additive, nullable, **applied manually, before deploy**) adds `ai_decision`, `suggested_slug`, `suggested_h1`, `suggested_title` — the only data with no existing home (the list API falls back to the old columns if 0014 is missing, the review POST answers 409). Human layer is never touched: only `review_status = 'pending'` clusters are sent, and the write itself is guarded by `review_status = 'pending'`, so a manual decision made during the run wins. Failed batch (or an answer the model got wrong: unknown id/page, CREATE without H1/Title) leaves those clusters undecided; finished decisions stay saved and pressing the button again continues with the undecided ones only after a failed run; otherwise (the table already holds AI decisions) the UI sends `force: true` and **every pending cluster is re-decided against the current pages** (e.g. after a Pages sync) — human-reviewed clusters are never re-sent or overwritten, and a re-decided cluster's old CREATE suggestion is cleared. Clustering, cleanup and the Router are unchanged.

### SEO → Query cleanup (AI relevance check before clustering)

The normal path is the single «AI-кластеризация» button (see «SEO → Clusters», it runs this cleanup automatically when needed); the screen `?screen=seo-cleanup` («Очистка запросов», `components/sections/keywords-cleanup.tsx`) stays for reviewing results, filtering, viewing excluded keywords and fixing `uncertain` by hand — visiting it is optional. Screen: the Keywords screen also got a status filter and decision/confidence/reason columns. API `app/api/keywords/relevance/route.ts` (GET counts + progress, GET `list=1` page by status, POST start/`resume`, PATCH manual decision). Logic `lib/keywords-relevance.ts` (jobs, DB), pure rules/prompt/validation `lib/keywords-relevance-rules.ts`. Migrations `db/migrations/0012_keyword_relevance.sql` (applied to production 2026-10-02) and `db/migrations/0013_project_seo_context.sql` (additive; **applied manually — not applied to production yet**; code treats a missing `project_seo_context` table as «no context»).

- **Storage:** on `keywords` — `relevance_status` (`target | informational | uncertain | geo_mismatch | irrelevant`, **NULL = AI has not checked it**; `uncertain` = checked, needs a human), `relevance_confidence`, `relevance_reason` (short Russian sentence), `relevance_manual`, `relevance_checked_at`; on `projects` — `relevance_cleanup_at` (NULL = project does not use cleanup; set in the same transaction as the project's first saved batch). Keywords are never deleted. `keywords.status`, `updated_at` (used by import provenance) and the Wordstat importer are untouched: an import upsert changes only frequency, so a re-import keeps classifications and new rows start NULL.
- **Project SEO context (explicit, per project):** table `project_seo_context` (one row per project, migration 0013): `business_type`, `region`, `services`, `planned_services`, `excluded` — free text, list fields one item per line, trimmed and capped (200 / 2000 chars). Edited on the «Очистка запросов» screen (`components/sections/keywords-cleanup.tsx` → `GET/PUT /api/projects/seo-context`, `lib/project-seo-context.ts`); saving it never starts AI work. Nothing is pre-filled for any project — values are entered by hand (DriveSet's is entered by the owner after deploy).
- **What the AI receives:** SEO context first (authoritative: business type, target region, main services → `target`, planned/additional directions → also part of the business even without a page, NOT OFFERED → `irrelevant`), then project name + domain and up to 40 existing pages as `path | title | h1 | description` (fields clipped to 140 chars) as additional facts — no HTML, no new profile. Region/services therefore no longer depend on pages alone. Popular/Similar and the seed query are not stored, so they are not used.
- **Exclusions need what they exclude against** (`decide`, `contextCaps`): `irrelevant` is saved only if the business is known (SEO context names a business type or services, or the project has page data); `geo_mismatch` only if the region is known (SEO context region, or page data). Otherwise the AI's answer is saved as `uncertain` («Нет данных о проекте…» / «Регион проекта не задан…», counted as `heldNoContext`) whatever its confidence; the cleanup screen warns when the project has neither context nor pages. Prompt: a city is a `geo_mismatch` only against a region the context names; the target region and its cities are never a mismatch; unknown region → judge the query as if the city were absent. (First DriveSet run: `pages` was empty and Moscow queries were marked `geo_mismatch`.)
- **«Перепроверить спорные и другой регион»** (cleanup screen, `POST …/relevance {requeue:'disputed'}`): resets only the AI's `uncertain` / `geo_mismatch` keywords (never `relevance_manual` ones) to «not checked» and runs cleanup on them — use after loading pages. It does not change clustering input (both statuses were excluded anyway).
- **Geo rule (target region may be a whole oblast):** the prompt says every settlement inside the SEO-context region (towns of the named oblast/krai/republic, not only the named city) is part of the target geography and never `geo_mismatch`; `geo_mismatch` only when the model is confident the place is outside, and then it must return `query_region` (region/country of the place). Code backstop in `decide` (only when the SEO context sets an explicit region): `query_region` missing or overlapping the target region (`regionsOverlap`, 4-letter word-prefix fingerprint, no city lists) → saved as `uncertain` (counted `geoRejected`, «оцените по остальному смыслу»). Unsure membership → not `geo_mismatch`. Region known only from pages (no explicit context): behaviour unchanged.
- **Materials / tools questions (prompt rule):** `NOT OFFERED` in the SEO context means the project does not SELL or do that — a query to buy/order/rent it is `irrelevant`, but a how-to-choose / what-is-needed question about materials, chemicals, pastes, pads, tools or equipment for the project's OWN services («какая химия нужна для химчистки салона», «какую пасту взять для полировки фар», «какие круги нужны», «какая машинка нужна») is `informational` (so it reaches clustering). `irrelevant` stays for queries off the project's topic. Prompt-only change (`RELEVANCE_SYSTEM_PROMPT` + the NOT OFFERED label of the context block); no code backstop, so verify on real answers after the next cleanup run.
- **Clustering input (unchanged, confirmed):** `createClusteringJob` selects keywords with `CLUSTERING_KEYWORD_FILTER_SQL` (`lib/seo-clustering.ts`): a project that uses cleanup clusters only `target` + `informational` — `geo_mismatch`, `irrelevant`, `uncertain` and not-yet-checked keywords never reach the clustering prompt. A benchmark script that clusters raw unclassified keywords bypasses this filter; production does not.
- **«Перепроверить только «Другой регион»»** (`POST …/relevance {requeue:'geo'}`): resets only AI `geo_mismatch` keywords (never `relevance_manual`) and reruns cleanup on them — the cheap fix for old false geo_mismatch; ~N/100 AI calls.
- **«Перепроверить всю AI-классификацию»** (cleanup screen, `POST …/relevance {requeue:'all'}`, behind a confirmation «Будут заново проверены N решений AI. Ручные решения сохранятся»): for when the SEO context changed substantially. Resets `relevance_status/confidence/reason/checked_at` of every keyword with `relevance_manual = false` and then runs cleanup on them. Never touches `relevance_manual = true`, keywords, frequencies, Wordstat imports or clusters (clusters change only at the next clustering run); until the cleanup finishes the reset keywords are out of clustering input like any unchecked keyword.
- **Output (compact since the cost optimization; the model never echoes the query):** `{"r":[[keyword_id,"t",confidence],[id,"u",confidence,"reason"],[id,"g",confidence,"query_region","reason"]]}` with one-letter codes `t` target, `i` informational, `u` uncertain, `g` geo_mismatch, `x` irrelevant. `t`/`i` rows carry **no reason** (the server stores `DEFAULT_REASONS`: «Целевой запрос по услуге проекта» / «Информационный запрос по теме проекта»); `u`/`x` carry a reason; `g` carries the place's region (`query_region`, used by the geo check) and optionally a reason (default «Указан другой регион: <region>»). The previous object form `{"results":[{keyword_id,relevance_status,confidence,reason,query_region}]}` is still accepted. Validated before saving: malformed rows, unknown ids/codes, non-numeric confidence and repeats are dropped (their keywords stay NULL and go to the second-chance batch, never guessed); an answer with no valid row (including a truncated one) fails the batch. Reason must be Cyrillic, one line, ≤160 chars, else a stock Russian reason. Stored statuses/columns are unchanged — only future AI calls differ.
- **Output limit and reasoning:** each call sends `maxTokens = rows × 45 + 1000` (100 rows → 5 500; the retry doubles it, capped at the Router's 12 000; `relevanceMaxOutputTokens`) and `reasoningMode: 'off'` + `metadata.task: 'seo-relevance-cleanup'`. Provider-specific meaning is decided by the Router (see `OLNOO_PROJECT_MAP.md` → «AI Router»). Deploy the Router change first: an older Router ignores `reasoningMode`, and thinking tokens count against the smaller limit.
- **Threshold (`RELEVANCE_CONFIDENCE_THRESHOLDS`, one constant):** target/informational ≥ 55, irrelevant/geo_mismatch ≥ 70; below it the saved status is forced to `uncertain` (original confidence kept, reason prefixed «Низкая уверенность AI (N%)»). Excluding is the costlier error, hence the higher bar. Not calibrated on real answers — re-tune after the first real run.
- **Batches:** 100 unique query texts per AI call (≈1.5k tokens context + ≈1.5k queries in, ≤5.5k out (limit above)), 3 calls in parallel, one retry each; 5 193 keywords ≈ 52 calls. Each batch is saved in its own transaction the moment it succeeds; the UPDATE re-checks `status IS NULL AND NOT relevance_manual`, so an AI answer never overwrites a manual decision or a keyword classified meanwhile. Queries the AI left out get one second-chance batch; if still missing they stay unclassified (reported as `unresolved`).
- **Failure / resume:** a malformed or failed batch (after one retry) fails only that batch; finished batches stay saved; «Продолжить» re-sends only failed batches. Because every batch is persisted, starting «Проверить запросы» again after a restart also selects only still-unclassified keywords — jobs are in memory (one per project) but no work is lost.
- **New keywords later:** a run selects only `relevance_status IS NULL AND NOT relevance_manual` — new imports, resets, or leftovers. Nothing new → no AI call (the API answers «Все запросы проверены»). The UI shows «N новых запросов требуют проверки» and the main button checks exactly those.
- **Manual override:** the decision select (cleanup table and Keywords table) sets the status with `relevance_manual = true`, reason «Решение пользователя»; ordinary cleanup never selects or writes such rows. «Сбросить» sets NULL and clears the flag (the next cleanup re-checks it). Service/API-level `reviewManual: true` re-checks manual rows on explicit request (no UI). A manual decision does not switch a project into cleanup mode.
