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

## SEO

- One search intent = one page. Do not create thin pages for synonyms.
- Public sites must have a sitemap.
- Create/Improve use the full keyword cluster, and must include CTA + internal links + pass the Quality Gate.

## Change rule

If a task changes domain, repository, production path, systemd service, port, database/storage, source of truth, an API relationship, a module relationship, or an important route — update `OLNOO_PROJECT_MAP.md` in the same commit. The task is not done until the documentation matches production.
