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

Responsibilities: public pages, SEO landing pages, contact form. The contact form writes new leads directly into the shared Postgres CRM (server-side, via `DATABASE_URL`, project `olnoo`) — no HTTP hop to `olnoo-admin` for lead creation.

`/admin/crm` and `/admin/social` (and all subpaths) redirect to `https://admin.olnoo.com/en?screen=crm-leads&project=olnoo` and `https://admin.olnoo.com/en?screen=social-posts&project=olnoo`. The legacy SQLite-backed CRM/Social UI (`app/admin/crm/*`, `app/admin/social/*`) and Admin API (`/api/admin/leads/*`, `/api/admin/social/*`) have been removed from this repo, along with `lib/leads.ts`, `lib/social-posts.ts`, `lib/social-types.ts`, and the `better-sqlite3` dependency — this repo no longer reads or writes SQLite. See `Legacy` below.

## OLNOO Admin

- domain: `admin.olnoo.com`
- repo: `RomanVaskin/olnoo-admin`
- production path: `/opt/olnoo/projects/olnoo-admin`
- systemd service: `olnoo-admin.service`
- port: `3140`
- env: `/opt/olnoo/projects/olnoo-admin/.env.local`
- technology: Next.js 16.3.3

`admin.olnoo.com` is the single shared Admin for all OLNOO projects — `olnoo.com` has no operational CRM/Social UI or API of its own anymore (see `OLNOO Main` above).

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

## Legacy (inactive, backup only)

The SQLite CRM/Social runtime has been fully retired from the `olnoo` repo — no code path reads or writes it anymore (see `OLNOO Main` above). `data/crm.sqlite` may still physically exist on the KZ server as a leftover file; it is a backup only, not deleted as part of that cleanup, and no task should read from or write to it. Deleting it from the server is a separate, not-yet-done step.

## Social

Source of truth: Postgres (`olnoo-admin`), table `social_posts`, `project_id → projects.id`. Live at `?screen=social-posts&project=<slug>`.

Confirmed API routes (`olnoo-admin`): `GET/POST /api/social` (list filtered by `?project=<slug>`, create), `GET/PATCH/DELETE /api/social/[id]` (all project-scoped — a post id from another project cannot be read, edited, or deleted by supplying a different project slug or vice versa).

Migration: `db/migrations/0005_social_posts.sql`.

Data layer: `lib/social.ts`, reuses `resolveProjectId` from `lib/crm.ts` — no separate project-resolution mechanism.

The old `olnoo` implementation (`app/admin/social/`, `app/api/admin/social/*`, SQLite `social_posts` table in `data/crm.sqlite`) has been removed from the `olnoo` repo; `/admin/social` (and subpaths) now redirect to `admin.olnoo.com`, the same way `/admin/crm` does. No delete endpoint existed in the old implementation; the current one has one.

### Social Accounts

Project-scoped inventory of social accounts (no real posting API connected yet — this is bookkeeping only, for future automation). Table `social_accounts` (`project_id → projects.id`), `platform` one of `telegram`/`instagram`/`threads`/`vk`, `status` one of `created`/`connected`. Live at `?screen=social-accounts&project=<slug>` (nav: Social → Accounts, alongside Posts).

API routes (`olnoo-admin`): `GET/POST /api/social-accounts` (list filtered by `?project=<slug>`, create), `GET/PATCH/DELETE /api/social-accounts/[id]` (project-scoped, same isolation guarantee as `/api/social`).

Data layer: `lib/social-accounts.ts`.

No real OLNOO accounts are seeded by migration — they are added manually via the Accounts UI after deploy.

### Publication tracking

Per-channel publication status for each post, table `social_publications` (`project_id → projects.id`, `social_post_id → social_posts.id` cascade-deleted with the post, `social_account_id → social_accounts.id` set null if the account is deleted). `status` one of `draft`/`ready`/`published`/`failed`. One row is auto-created (status `draft`) the first time a post's Publications block is opened for each channel currently selected on that post — channels later deselected keep their existing row rather than being deleted.

API routes (`olnoo-admin`): `GET /api/social-publications?post=<id>&project=<slug>` (ensures rows exist for the post's current channels, then lists all of them), `PATCH /api/social-publications/[id]` (project-scoped; assigning a `social_account_id` is rejected with 400 if that account doesn't belong to the same project). Setting `status` to `published` sets `published_at` to now (if not already set); setting it to anything else clears `published_at`.

MVP UI only: manual "Mark as published" (optionally with an external URL) and "Back to ready" inside the post's Publications block. No automated posting to any platform exists yet.

`social_publications` is the only source of truth for whether a post is actually published — `social_posts.status` cannot manually claim `published`. All the reconciliation and creation logic lives in `lib/social.ts` (`syncPostStatusFromPublications`, `ensurePublicationsForChannels`, `isFullyPublished`) so `lib/social-publications.ts` can import it without a circular dependency; `status` becomes `published` only once every currently selected channel has a `published` publication, and is demoted back to `ready` the moment that stops holding. Read paths are strictly read-only — `listPublicationsForPost` never writes anything, not even to create a missing publication row. Reconciliation runs only after an operation that actually changes state: a publication's status changes (`updateSocialPublication` in `lib/social-publications.ts`), or the post's own selected channels change (`updateSocialPost`/`createSocialPost` in `lib/social.ts`, which is also where missing publication rows get created — always as a side effect of channels being set, never of a read). `updateSocialPost` also rejects `status: 'published'` outright (400) if the resulting channel set isn't actually fully published yet, and `createSocialPost` rejects creating a post already published — the API enforces this, not just the UI's disabled dropdown option. The Post UI computes the same fully/partially-published/ready/draft summary live from `social_publications` (`components/sections/social-publications.tsx`, `summarizePublications`) — nothing new is stored for this, it's derived on every read.

Migration: `db/migrations/0007_social_accounts_publications.sql` (both tables).

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
