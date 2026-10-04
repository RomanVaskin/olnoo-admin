# OLNOO Architecture

Design and development rules for OLNOO modules. Current production facts (repos, paths, services, ports, DB, routes) live in `OLNOO_PROJECT_MAP.md`, not here.

## Core hierarchy

`Client → Project → modules`

Modules: `SEO`, `CRM`, `Social`, `Ads`, `Analytics`.

Project is the main connecting object between modules. One Client can have several Projects.

## Principles

- **One source of truth.** Each entity has exactly one current data source (e.g. CRM leads live in Postgres, not Postgres + SQLite). A legacy store may remain temporarily, but must not receive new data.
- **Reuse existing OLNOO module first.** Do not create a new service, repository, database, or app if the task can be solved inside an existing module.
- **No new DB/service/repo unless necessary.**
- **Modules live inside `olnoo-admin` where possible** — a separate repository is for a separate application, not for each functional module.
- **Module data is project-scoped.** New project-scoped entities reuse the existing `Project` (via `project_id` FK, resolved through `projects.slug`) — do not create a parallel Client/Project concept.
- **Leads from any channel (Website, SEO, Social, Ads, Telegram, ...) go into the shared CRM**, not a per-channel table.
- **Client work should be reusable** where practical, rather than one-off per client.
- **A second repetition of a manual action is a candidate for automation** — but automation must not violate the "don't overcomplicate" principle.

## CRM intake from messengers

- **Record, never converse.** Messenger integrations (Telegram Business today) only turn a client's incoming message into a CRM lead. No auto-replies, no chatbot, no AI answers: the code calls no Bot API method that writes to a chat, and the bot is connected without reply rights. Managers answer clients in the messenger themselves.
- **A click is not a lead.** A site click on a Telegram/MAX/phone link is a contact intent and stays an analytics micro-conversion (Metrika); a lead is a message actually received or a form actually submitted.
- **One open lead per person per channel.** Follow-up messages never create another lead while one is open; after Won/Lost a new message is a new enquiry.
- **No invented attribution.** A messenger message carries no ad attribution, so such leads are `source=Direct` (the CRM's direct/unknown value) — never Ads/Yandex Direct without confirmed attribution.

## Ads Agent

- **Yandex-first, observer first.** OLNOO Ads Agent v0.1 only reads (Yandex Direct, later Metrika + CRM) and analyses; it changes nothing in an ad account. No multi-platform adapter layer before a second real integration exists.
- **Deterministic layer vs AI.** Integration clients (e.g. `lib/yandex-direct.ts`) are plain server-side code: typed responses, normalised errors, no AI, no UI knowledge. Code computes spend/CPC/CPL/funnel; the AI Router only interprets, prioritises and recommends.
- **Pipeline order.** Direct Observer (ready) → CRM Observer, read-only (`/api/crm/observer/leads`) → Metrika read-only → unified analytics → AI recommendations → drafts/approval → writes. Each stage only reads and exposes a stable, period-compatible shape (calendar days in `Europe/Moscow`); the join of Direct, Metrika and CRM is a later, separate layer and is never guessed inside a source.
- **Honest signals.** A click on a contact link is a contact intent, not a lead; attribution is EXACT / PROBABLE / UNKNOWN, never presented stronger than it is.
- **Writes are a separate future path** (AI proposal → deterministic draft → BEFORE/AFTER → human approval → deterministic apply → audit log) with its own module; the read client must not grow write methods.

## SEO

- One search intent = one page. Do not create thin pages for synonyms.
- Public sites must have a sitemap.
- Create/Improve use the full keyword cluster, and must include CTA + internal links + pass the Quality Gate.
- Search queries are cleaned by AI before clustering: every keyword gets a stored relevance status (NULL = not checked, distinct from `uncertain`), low confidence is downgraded to `uncertain` deterministically, manual decisions are never overwritten by AI, and clustering reads the live status. Projects that never ran cleanup keep the old behaviour. The AI is told about the project through an explicit per-project SEO context (business, region, services, planned directions, what is not offered) plus existing pages, never pages alone; an exclusion the AI could not back with known business/region data is not saved. The user does not run cleanup separately: the single clustering action runs it first when keywords are unclassified (`lib/seo-pipeline.ts` only orchestrates — cleanup and clustering keep their own jobs and rules).
- AI clustering of any size runs in batches and then merges clusters across batches by search intent; one intent must never end up as several clusters because of batch boundaries. Human-reviewed clusters are kept on re-runs.
- A bulk keyword import is one batch: one operation, one transaction, recorded with the exact keywords it brought. Correcting a mistaken import = «Удалить импорт» (deletes only what is proven to come from that import; anything ambiguous is shown and kept) and importing the files into the right project — no separate transfer feature.

## Change rule

If a task changes domain, repository, production path, systemd service, port, database/storage, source of truth, an API relationship, a module relationship, or an important route — update `OLNOO_PROJECT_MAP.md` in the same commit. The task is not done until the documentation matches production.
