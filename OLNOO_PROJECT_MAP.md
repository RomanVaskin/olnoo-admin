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

Post fields (create/edit UI): Topic, Content (shared body), Channels (`telegram`/`instagram`/`threads`/`vk`), Publish date, Status, and an optional per-channel text override per selected channel. `category` is a legacy column still present in the table — no longer shown in create/edit, the Posts list, or search; existing rows keep whatever value they already had, and new rows never get one written.

Per-channel text: every selected channel uses the shared Content by default. The "Different text per channel" toggle (off by default; auto-enabled when opening a post that already has a real override) reveals a text field for each *currently selected* channel when on — an empty field there falls back to Content. Turning the toggle off and saving clears the per-channel overrides for the channels selected at that moment; Content itself is never touched, and a channel's override is left alone while that channel isn't currently selected.

"Generate variants" (post edit UI, shown once Content is non-empty and at least one channel is selected) calls the existing OLNOO AI Router (`lib/ai-router.ts`'s `callAiRouter`, the same client SEO clustering uses — no separate provider integration) via `POST /api/social/generate-variants` (`lib/social-ai.ts`, project-scoped through the same `resolveProjectId`; sends Topic, Content, the selected channels, and project name/domain as context). The output language is always detected from Content itself (`detectContentLanguage` — Cyrillic present means Russian, otherwise English); the UI's interface locale is never sent to this endpoint and never affects the generated language, only the app's own interface strings — a Russian Content on an English-locale screen (or vice versa) still generates in Russian. The AI Router returns JSON with one key per requested channel only — the server drops any other key even if the model returns one — and the client fills the matching per-channel fields, turns the toggle on, and stops: nothing is sent to the server until the user clicks Save. No autoposting; this only asks the Router for text.

Migration: `db/migrations/0005_social_posts.sql`.

Data layer: `lib/social.ts`, reuses `resolveProjectId` from `lib/crm.ts` — no separate project-resolution mechanism.

The old `olnoo` implementation (`app/admin/social/`, `app/api/admin/social/*`, SQLite `social_posts` table in `data/crm.sqlite`) has been removed from the `olnoo` repo; `/admin/social` (and subpaths) now redirect to `admin.olnoo.com`, the same way `/admin/crm` does. No delete endpoint existed in the old implementation; the current one has one.

### Social Accounts

Project-scoped inventory of social accounts (no real posting API connected yet — this is bookkeeping only, for future automation). Table `social_accounts` (`project_id → projects.id`), `platform` one of `telegram`/`instagram`/`threads`/`vk`, `status` one of `created`/`connected`. Live at `?screen=social-accounts&project=<slug>` (nav: Social → Accounts, alongside Posts).

API routes (`olnoo-admin`): `GET/POST /api/social-accounts` (list filtered by `?project=<slug>`, create), `GET/PATCH/DELETE /api/social-accounts/[id]` (project-scoped, same isolation guarantee as `/api/social`).

Data layer: `lib/social-accounts.ts`.

No real OLNOO accounts are seeded by migration — they are added manually via the Accounts UI after deploy.

### Publication tracking

Per-channel publication status for each post, table `social_publications` (`project_id → projects.id`, `social_post_id → social_posts.id` cascade-deleted with the post, `social_account_id → social_accounts.id` set null if the account is deleted, plus `external_url`, `external_post_id`, `published_at`, `error`). `status` one of `draft`/`ready`/`published`/`failed`. One row is auto-created (status `draft`) for each channel as it's selected on the post — always as a side effect of the post's `channels` being written (`updateSocialPost`/`createSocialPost` in `lib/social.ts`), never from reading the Publications list. Channels later deselected keep their existing row rather than being deleted.

API routes (`olnoo-admin`): `GET /api/social-publications?post=<id>&project=<slug>` (pure read — lists whatever publication rows already exist for the post; creates nothing), `PATCH /api/social-publications/[id]` (project-scoped; assigning a `social_account_id` is rejected with 400 if that account doesn't belong to the same project). Setting `status` to `published` sets `published_at` to now (if not already set); setting it to anything else clears `published_at`.

MVP UI: manual "Mark as published" (optionally with an external URL) and "Back to ready" inside the post's Publications block, for every platform except Telegram and VK. Telegram and VK have real automated posting (see below); Instagram/Threads still have no platform API connected.

`social_publications` is the only source of truth for whether a post is actually published — `social_posts.status` cannot manually claim `published`. All the reconciliation and creation logic lives in `lib/social.ts` (`syncPostStatusFromPublications`, `ensurePublicationsForChannels`, `isFullyPublished`) so `lib/social-publications.ts` can import it without a circular dependency; `status` becomes `published` only once every currently selected channel has a `published` publication, and is demoted back to `ready` the moment that stops holding. Read paths are strictly read-only — `listPublicationsForPost` never writes anything, not even to create a missing publication row. Reconciliation runs only after an operation that actually changes state: a publication's status changes (`updateSocialPublication` in `lib/social-publications.ts`), or the post's own selected channels change (`updateSocialPost`/`createSocialPost` in `lib/social.ts`, which is also where missing publication rows get created — always as a side effect of channels being set, never of a read). `updateSocialPost` also rejects `status: 'published'` outright (400) if the resulting channel set isn't actually fully published yet, and `createSocialPost` rejects creating a post already published — the API enforces this, not just the UI's disabled dropdown option. The Post UI computes the same fully/partially-published/ready/draft summary live from `social_publications` (`components/sections/social-publications.tsx`, `summarizePublications`) — nothing new is stored for this, it's derived on every read.

Migration: `db/migrations/0007_social_accounts_publications.sql` (both tables). Applied to production.

### Telegram autoposting

MVP automated posting for Telegram only (VK/Instagram/Threads are untouched — still manual, see above). From the post's Publications block, a `telegram`-platform publication that isn't already `published` shows a "Publish to Telegram" button in place of the manual "Mark as published" button; other channels are unaffected.

`POST /api/social-publications/[id]/publish-telegram?project=<slug>` (`lib/social-telegram.ts`, project-scoped through `resolveProjectId` like every other route in this module) calls the Telegram Bot API's `sendMessage` directly (no separate provider service, unlike the AI Router) using a bot token read from the server-only env var `TELEGRAM_BOT_TOKEN` — never stored in Postgres or Git, never sent to the browser. `TELEGRAM_API_BASE_URL` is a second, non-secret env var (default `https://api.telegram.org`) that only exists so a non-production environment can point at a mock server for testing, the same role `AI_ROUTER_URL` plays for `lib/ai-router.ts`.

Text sent is `social_posts.telegram_text` if non-empty, else `social_posts.body`. The target chat is the `social_accounts` row linked via the publication's `social_account_id` if set (rejected with 400 if that account isn't itself a `telegram` account), else the project's first `active` `telegram` account (`ORDER BY created_at ASC`) — there is no per-post channel picker yet, one active Telegram account per project is assumed. `external_url` is built as `https://t.me/<account.username without a leading "@">/<message_id>`.

No schema change: this reuses `social_publications`' existing `status`/`external_post_id`/`external_url`/`published_at`/`error` columns, all already present in `0007_social_accounts_publications.sql`. On success the row is set to `status='published'`, `external_post_id` = Telegram's `message_id`, `external_url` as above, `published_at`, `error` cleared, then `syncPostStatusFromPublications` runs same as any other publication write. On a Telegram API error (bad request, chat not found, network failure) the row is set to `status='failed'` with the message in `error` — this is not thrown as an HTTP error, the route still returns 200 with the row, so the existing UI's error display (`publication.error`) shows it directly; calling the endpoint again from `failed` is a normal retry (nothing marks it non-retryable). Calling the endpoint on a publication that is already `published` is rejected with 409 before any Telegram API call (duplicate-send protection); calling it on a non-`telegram` publication is rejected with 400. No scheduler or background job exists — this only ever runs synchronously from the button click.

### VK autoposting

MVP automated posting for VK only, built on the same pattern as Telegram autoposting above (VK/Telegram are now both automated; Instagram/Threads are untouched — still manual). From the post's Publications block, a `vk`-platform publication that isn't already `published` shows a "Publish to VK" button in place of the manual "Mark as published" button; Telegram's flow is unchanged.

`POST /api/social-publications/[id]/publish-vk?project=<slug>` (`lib/social-vk.ts`, project-scoped through `resolveProjectId` like every other route in this module) calls the VK API's `wall.post` (`POST https://api.vk.com/method/wall.post`, `from_group=1` so the post is published as the community, not as the token's own user) using an access token read from the server-only env var `VK_ACCESS_TOKEN` — never stored in Postgres or Git, never sent to the browser. Must be a community/group access token, or a user token with `wall,groups` scope obtained via VK's classic OAuth — a `vk2.a.*` token from the newer id.vk.com PKCE login flow cannot call `wall.post`. `VK_API_BASE_URL` is a second, non-secret env var (default `https://api.vk.com`) with the same role as `TELEGRAM_API_BASE_URL`/`AI_ROUTER_URL` — only for pointing a non-production environment at a mock VK API.

Text sent is `social_posts.vk_text` if non-empty, else `social_posts.body`. The target community is the `social_accounts` row linked via the publication's `social_account_id` if set (rejected with 400 if that account isn't itself a `vk` account, or isn't `active`), else the project's first `active` `vk` account (`ORDER BY created_at ASC`) — same one-active-account-per-project assumption as Telegram. That account's `username` (or, if empty, the last path segment of its `public_url`) becomes the VK `owner_id`: a numeric value (with or without a leading `-`) is used directly, anything else (a screen name like `olnoo_ai` or `club212959296`) is resolved server-side via VK's own `utils.resolveScreenName` at request time — no schema change to pre-store a numeric id. A screen name that resolves to `type: 'user'` (a personal profile, not a community) is rejected with 400. `external_url` is built as `https://vk.com/wall<owner_id>_<post_id>` (VK's own canonical permalink format, valid regardless of the community's short name).

No schema change: reuses the same `social_publications` columns as Telegram. On success: `status='published'`, `external_post_id` = VK's `post_id`, `external_url` as above, `published_at`, `error` cleared, then `syncPostStatusFromPublications` runs. On a VK API error (`{"error": {"error_code", "error_msg"}}`) or network/resolve failure, the row is set to `status='failed'` with the message in `error`, leaving `external_post_id`/`external_url` untouched — not thrown as an HTTP error, so the route returns 200 with the row and the UI shows it via `publication.error`; calling the endpoint again from `failed` is a normal retry. Calling the endpoint on an already-`published` publication is rejected with 409 before any VK API call (duplicate-send protection); calling it on a non-`vk` publication is rejected with 400. No scheduler or background job — synchronous, on-demand from the button click only. Media/attachments are not supported yet — text-only posts.

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
