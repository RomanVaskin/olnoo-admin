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

- **Yandex-first, observer first.** OLNOO Ads Agent v0.1 only reads (Yandex Direct, Metrika, CRM) and analyses; it changes nothing in an ad account. No multi-platform adapter layer before a second real integration exists.
- **Deterministic layer vs AI.** Integration clients (e.g. `lib/yandex-direct.ts`) are plain server-side code: typed responses, normalised errors, no AI, no UI knowledge. Code computes spend/CPC/CPL/funnel; the AI Router only interprets, prioritises and recommends.
- **Pipeline order.** Direct Observer (ready) → CRM Observer, read-only (`/api/crm/observer/leads`, ready) → attribution capture (A1 CRM side, then A2, the DriveSet side) → Metrika Observer, read-only (`/api/metrika/observer`, aggregates only, no Logs API, no visitor identifiers; production confirmed) → Unified Analytics v0.1, read-only (`/api/ads/unified`: Direct + Metrika + CRM read through their libraries, concurrent, partial answers with warnings, CPL only when attribution allows it and always labelled AGGREGATED; explicit project test-traffic markers; no personal data) → Direct Agent MVP HARD MODE (below and `OLNOO_PROJECT_MAP.md`: MCP Eyes v1 → Negative Query Detector v1 → AI explanation → human confirmation → manual apply, Hand v1 later). Each source stage only reads and exposes a stable, period-compatible shape (calendar days in `Europe/Moscow`); the join of Direct, Metrika and CRM happens only in the unified layer and is never guessed inside a source. A click-to-lead link is never claimed stronger than AGGREGATED until a proven per-visit key exists. Attribution identifiers are optional and best-effort: their absence never blocks a lead.
- **Honest signals.** A click on a contact link is a contact intent, not a lead; attribution is EXACT / PROBABLE / UNKNOWN, never presented stronger than it is.
- **Writes are a separate future path** with its own protected module / admin route; the read client must not grow write methods, and no write is ever exposed through the open `/api/mcp` endpoint. First and only planned write (Hand v1): campaign-level negative keywords — read current → compare with the version the human approved → merge (never replace the list with only the new phrases) → write → re-read → verify → minimal audit log. No generic approval/action framework or tables before that is proven useful.
- **Direct Agent — MVP HARD MODE.** First scenario: read search queries → deterministic detector → AI explanation → negative-keyword proposal → human confirmation → manual apply → re-read/verify. At most 3 PRs (Eyes v1, Detector v1, Hand v1); the scope, the "do not build" list and the data limits (a query cannot be tied to a REAL CRM lead; only AGGREGATED Direct + Metrika signals) are in `OLNOO_PROJECT_MAP.md` → "Direct Agent — MVP HARD MODE". Code computes, the LLM only explains and proposes candidates.

## Lead traffic classification

- **Three classes, not a boolean.** A lead is `REAL`, `TEST` or `UNKNOWN`; a lead that cannot be proven REAL or TEST is UNKNOWN, and UNKNOWN is never treated as REAL. Automatic class + reason are stored with the lead; a human override (REAL/TEST) wins; effective class = `override ?? auto`.
- **Test traffic is marked by a plain UTM** (`utm_source=olnoo&utm_medium=test&utm_content=olnoo_test&utm_term=<sessionId>`) — no cookie, token, secret or DriveSet code. The classifier lives in the CRM (`lib/traffic-class.ts`): test UTM / legacy markers / known test contacts (server env, never in Git) → TEST; **REAL only** for leads from the trusted DriveSet inbound API at/after an explicit activation boundary (server env `DRIVESET_TEST_CLASSIFICATION_SINCE`) with no marker; everything else UNKNOWN. A client-side flag is never authoritative.
- **Unified Analytics counts by the effective class** and computes CPL from REAL direct leads only (TEST and UNKNOWN excluded; `unclassified_leads_pending` warns when UNKNOWN direct leads exist). Old Unified fields remain as aliases. Metrika excludes the same test traffic by exact UTM filters. Details and activation steps: `OLNOO_PROJECT_MAP.md`.

## OLNOO Agent v1 (MCP)

- **AI reads OLNOO through one read-only MCP tool**, `get_driveset_summary(period)` at `POST /api/mcp` (official SDK, stateless Streamable HTTP). It calls the existing Unified Analytics and returns a small whitelist DTO — no second implementation of Direct/Metrika/CRM, no personal data, no write tools, no project parameter. The endpoint has no application auth; nginx opens exactly this path. Direct MCP Eyes v1 adds a second read-only tool, `get_direct_queries` (top search queries + current negative keywords from the existing Direct client), available only to requests with the server key `OLNOO_MCP_KEY`. Details and the manual nginx step: `OLNOO_PROJECT_MAP.md`.

## SEO

Full description, current status and roadmap: [`docs/SEO_AGENT.md`](docs/SEO_AGENT.md) (single source of truth). Principles only:

- **Minimal SEO module + read-only SEO Observer.** No separate SEO Agent / Content Agent / Developer Agent / Orchestrator until a real need appears. The page change is made by Claude Code from a generated task, with a manual PR; nothing in SEO changes without human confirmation.
- One search intent = one page; no thin pages for synonyms. Public sites must have a sitemap.
- AI recommendation is not human confirmation. `seo_clusters.confirmed_page_id` (with `review_status`) is the only source of truth for cluster → page; a keyword's page is derived from its cluster, not stored separately.
- Improve uses all confirmed clusters of the page in one task. Improve and Create must carry the factual guardrail, CTA and internal-link rules and the Coverage/Quality Gate review — as part of the prompt and PR review, not as DB entities (current gaps: status in `docs/SEO_AGENT.md`).
- Language, market and region are properties of the project's SEO context; no per-language branches of business logic.
- SEO Observer is read-only with one normalised data shape and a connector per provider (Yandex first, Google later). No adapter abstraction before a second real integration — the same rule as the Ads Agent.
- A change to the SEO pipeline's facts is recorded in `docs/SEO_AGENT.md` in the same commit.

## Change rule

If a task changes domain, repository, production path, systemd service, port, database/storage, source of truth, an API relationship, a module relationship, or an important route — update `OLNOO_PROJECT_MAP.md` in the same commit. The task is not done until the documentation matches production.
