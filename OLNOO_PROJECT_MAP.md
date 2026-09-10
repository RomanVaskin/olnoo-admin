# OLNOO Project Map

Confirmed production facts only. Design/development rules live in `OLNOO_ARCHITECTURE.md`; read both before any OLNOO task (see `AGENTS.md`).

Do not re-discover repo/path/service/port/database if it is already recorded here. If a task confirms a change to domain, repo, path, service, port, storage, route, or source of truth, update this file in the same commit.

## OLNOO Main (public site)

- domain: `olnoo.com`
- repo: `RomanVaskin/olnoo`
- production path: `/opt/olnoo/projects/olnoo`
- systemd service: `olnoo-web.service`
- port: `3130`
- env: `/opt/olnoo/projects/olnoo/.env.local`
- technology: Next.js 16.3.3

Responsibilities: public pages, SEO landing pages, contact form. The contact form writes new leads directly into the shared Postgres CRM (server-side, via `DATABASE_URL`).

`/admin/crm` redirects to `https://admin.olnoo.com/en?screen=crm-leads&project=olnoo`.

## OLNOO Admin

- domain: `admin.olnoo.com`
- repo: `RomanVaskin/olnoo-admin`
- production path: `/opt/olnoo/projects/olnoo-admin`
- systemd service: `olnoo-admin.service`
- port: `3140`
- env: `/opt/olnoo/projects/olnoo-admin/.env.local`
- technology: Next.js 16.3.3

Unified admin panel. Screens read `?project=<slug>` from the URL.
CRM Overview: `/en?screen=crm-overview&project=<slug>`. CRM Leads: `/en?screen=crm-leads&project=<slug>`. Current production example: `project=olnoo`.

No authentication layer exists on this app yet (no login, no session, no middleware) — every route, including CRM writes, is reachable by anyone who can reach the domain. This is a known, pre-existing gap, not something to silently patch as a side effect of an unrelated task.

## CRM

Source of truth: Postgres (same database used by `olnoo-admin`).

Tables: `clients`, `projects`, `leads`.
Relationship: `leads.project_id → projects.id`.
Project resolution: `projects.slug` (e.g. `olnoo`, `insurance`, `aura`, `marketing`).

New leads from `olnoo.com` are written directly into this Postgres `leads` table by the contact form's own server-side code (`olnoo` repo, `lib/crm-db.ts` + `app/api/contact/route.ts`) — there is no HTTP hop between the two apps for lead creation.

Confirmed API routes (`olnoo-admin`):
- `GET/POST /api/leads` — list (filtered by `?project=<slug>`) and create; used by the Admin UI itself.
- `PATCH/DELETE /api/leads/[id]` — edit and delete.
- `GET /api/projects`, `GET /api/clients`.
- `POST /api/leads/inbound` exists (API-key-authenticated server-to-server intake) but is **not currently used** — superseded by the direct-Postgres write above after the key-based path proved unreliable in production. Left in place; do not build new integrations against it without re-confirming it's wanted.

Migration: `db/migrations/0004_crm_leads.sql` (added `leads` table + `projects.slug`). Applied to production.

CRM rules: Postgres is the only current source of truth for new leads; do not create a second CRM database; `crm-overview` and `crm-leads` read the same data; status/notes persist in Postgres.

## Legacy — do not remove, do not extend

- SQLite `data/crm.sqlite` in the `olnoo` repo (`lib/leads.ts`) — no longer receives new leads. Still backs the old `/admin/crm` UI, which is now unreachable via browser (redirected) but not deleted.
- `olnoo` repo API routes `/api/admin/leads`, `/api/admin/leads/[id]`, `/api/admin/leads/export` — still live, still write to SQLite if called directly (the redirect only affects browser navigation to `/admin/crm`, not direct API calls). Known technical debt; not removed by design (out of scope for the CRM consolidation work).

## Social

Source of truth: Postgres (`olnoo-admin`), table `social_posts`, `project_id → projects.id`. Live at `?screen=social-posts&project=<slug>`.

Confirmed API routes (`olnoo-admin`): `GET/POST /api/social` (list filtered by `?project=<slug>`, create), `GET/PATCH/DELETE /api/social/[id]` (all project-scoped — a post id from another project cannot be read, edited, or deleted by supplying a different project slug or vice versa).

Migration: `db/migrations/0005_social_posts.sql`.

Data layer: `lib/social.ts`, reuses `resolveProjectId` from `lib/crm.ts` — no separate project-resolution mechanism.

The old `olnoo` implementation (`app/admin/social/`, `app/api/admin/social/*`, SQLite `social_posts` table in `data/crm.sqlite`) still exists and is **not yet redirected** (unlike `/admin/crm`) — decide and wire that redirect only after the new Social screen is confirmed working in production. No delete endpoint existed in the old implementation; the new one adds one.

## AI Router

- repo: `RomanVaskin/olnoo-ai-router`
- default port (from its own `.env.example`, not independently confirmed against a running production process): `3010`

Production path/systemd service on KZ are not confirmed — do not guess them; confirm via the same runtime-tracing method used for the two apps above (nginx config → port → systemd unit → `git remote -v`) if a task needs them.

## Known repo look-alikes

- `RomanVaskin/olnoo-admin` = production `admin.olnoo.com`.
- `RomanVaskin/olnoo-admin-48` — do **not** treat as production without separate confirmation.
- `RomanVaskin/olnoolopisadmin` — this is Sportpolis admin, **not** `admin.olnoo.com`.

## Agent capabilities (stable constraints)

- GitHub repo read/write depends on the current session's permissions; a repo may need to be attached before it can be read or pushed to.
- `git push` to a repo's `main` may require explicit user confirmation, particularly when the push triggers an auto-deploy.
- Do not assume SSH access to the KZ server exists.
- Do not assume direct network access to production domains (`olnoo.com`, `admin.olnoo.com`) exists from the agent's own environment — it may not.
- If access is missing for a step, give the user one minimal, ready-to-run command for that step — not a long diagnostic sequence.
