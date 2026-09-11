# Read first

Before any OLNOO technical or product task, read:

- `OLNOO_PROJECT_MAP.md` — confirmed production facts (domains, repos, paths, services, ports, DB, routes).
- `OLNOO_ARCHITECTURE.md` — design/development rules for new and existing modules.

Do not re-discover repo/path/service/port/database if it is already recorded there.

## Task execution rules

- Flow: **problem → minimal fix → verification.**
- Do not run long diagnostic cycles. Diagnose only as far as needed to make a safe fix.
- Do not create a second database or a second source of truth for something that already has one.
- Do not change neighboring modules without necessity.

# OLNOO Engineering & Product Rules

## Mandatory decision order
Before every technical, product, client, or project response/task, apply:

**PR1 → PR2 → PR3 → PR4 → answer/action**

## PR1 — Keep it simple
Always choose the simplest, most direct, reliable path with the fewest steps, services, and changes.

- Do not add infrastructure, services, databases, queues, integrations, or abstractions unless necessary.
- Prefer MVP first.
- Reuse existing OLNOO modules/components before creating new ones.
- Do not build for hypothetical future needs.
- Do not automate for automation’s sake.
- For simple tasks, keep prompts and implementation small.

## PR2 — Think critically
Do not agree automatically.

- Check root cause, alternatives, risks, and tradeoffs.
- Prefer fixing recurring root causes over symptoms.
- If there is a simpler or more correct approach, propose it.
- Do not continue a bad architecture just because it already exists.
- Avoid custom one-off work when a reusable solution is practical.

## PR3 — Give AI precise tasks
For Claude/Codex/other coding agents, specify when relevant:

- exact project and folder;
- exact goal and expected result;
- exact scope;
- files that may be changed;
- files/systems that must not be changed;
- concrete values/constraints;
- definition of done;
- minimum necessary checks;
- whether to commit/push;
- whether production changes are allowed.

For a small task, use a short prompt.

## PR4 — Automate and scale
Always look for ways to remove repetitive manual work:

- copying;
- repeated input;
- checks;
- deploys;
- reporting;
- monitoring;
- synchronization;
- publishing;
- repeated client operations.

Before client/product work, ask:

1. Can this be solved with an existing OLNOO module?
2. Can the solution be reusable for other clients?
3. Are we creating recurring manual work?
4. If an action repeats a second time, should it become an automation candidate?
5. Can client work improve the OLNOO product itself?
6. Will more clients require proportionally more manual time?

Main question:

**“Does this make OLNOO more scalable, or does it just add another manual task?”**

PR4 does not override PR1.

# OLNOO architecture

Prefer one integrated OLNOO Admin over separate apps.

Core flow:

**Client → Project → SEO → CRM → Social → Ads → Analytics**

Develop modules in this order unless there is a stronger immediate business reason:

**SEO → CRM/Leads → SEO↔CRM analytics → Social → Ads → Analytics**

Do not build all modules at once.

# Client work

Each client should ideally improve the product.

Preferred pattern:

Client #1 → solve task → convert reusable parts into OLNOO capability  
Client #2 → reuse the capability  
Client #3 → mostly automated

Avoid:

Client #1 → custom manual work  
Client #2 → same manual work again  
Client #3 → same again

One-off custom work is allowed when truly unique, but it should not silently become the default operating model.

# Git / GitHub

GitHub is the main code source for managed OLNOO sites.

Rules:

- Do not use `git add .` in a dirty repo unless there is a specific reason.
- Commit only task-related files.
- Do not touch unrelated local changes.
- Do not overwrite another person’s uncommitted work.
- Do not use `git push --force`, `git reset --hard`, or `git clean` without explicit need and understanding.
- If a local checkout may be stale, first check:
  - `git status -sb`
  - current `origin/main`
- If a repo is actively changed via Claude Web/GitHub by someone else, do not assume the local copy is current.

# Deploy

If a project already has autodeploy, use it.

Do not change without necessity:

- GitHub Actions;
- deploy workflows;
- secrets;
- Nginx;
- systemd;
- production ports.

If manual deploy repeats, treat it as an automation candidate.

Always state whether commands run on **Mac** or **KZ**, and provide the exact project folder.

If already on KZ, do not tell the user to `ssh olnoo-kz` again.

# Secrets

Never commit or expose:

- API keys;
- tokens;
- passwords;
- production secrets.

Production env/secrets stay outside Git.

`.env.example` may contain only variable names and safe examples.

# Media

Do not keep heavy videos/media in Git unless necessary.

Use Git for:
- code;
- lightweight images/assets.

Store large media on the server or suitable object/file storage.

# Design

Preserve existing design and components.

OLNOO style:
- premium minimal;
- clean;
- strong typography;
- generous whitespace;
- Geist Sans/Mono;
- white/warm white/graphite;
- restrained blue;
- editorial / Swiss / technical feel.

Avoid:
- generic SaaS cards;
- unnecessary redesign;
- neon AI aesthetics;
- visual clutter;
- excessive gradients.

Do not change the OLNOO logo/brand geometry without explicit instruction.

# SEO principles

Main rule:

**One real search intent = one page.**

Do not create:
- one page per keyword;
- thin pages for synonyms;
- thin city pages without a distinct local intent/value.

Primary keyword = main query for the page.

Secondary keywords = naturally covered through:
- Title;
- Description;
- H1;
- H2/H3;
- body content;
- FAQ;
- commercial blocks.

Do not keyword-stuff.

All significant topics in a cluster should be meaningfully covered.

# SEO workflow

**Semantics/Wordstat → Keywords → AI clustering → Existing page / No page / Ignored → Human review → Improve/Create → SEO Coverage → Quality Gate → CTA → Internal links → Publish → Sitemap → Indexing → Search data → Improve again**

AI recommendation is not the same as human confirmation.

If AI finds a page:

**Recommend → Confirm → or Find another**

If AI says no page:

**No page → Create page → or Find existing**

Do not force users to browse huge dropdowns; use search over URL/title/H1.

# SEO Create / Improve

Improve:
- use the confirmed existing page;
- keep design/components;
- change only what is needed.

Create:
- create one page for one cluster/search intent;
- first check for an existing page with the same intent;
- if one exists, do not create a duplicate.

Always pass the whole cluster as a semantic map.

Do not mechanically insert every long-tail phrase.

# SEO CTA / conversion

SEO pages should lead to a meaningful next action.

Commercial intent:
- CTA in the main body;
- CTA near the end;
- reuse existing contact flow;
- do not create a new form when a working one already exists;
- do not send users to the homepage without reason.

Informational intent:
- softer relevant CTA.

For `olnoo.com`, reuse the existing contact / ProjectRequest flow and do not change the working Resend/email flow unless needed.

# SEO Quality Gate

After Create/Improve, perform a critical review for:
- unsupported claims;
- overpromising;
- invented facts;
- keyword stuffing;
- unnatural language;
- scope creep;
- design regressions.

Do not invent:
- clients;
- case studies;
- numbers;
- results;
- partners;
- certificates;
- awards;
- experience.

If a factual claim is not supported by project data, rewrite it in a neutral form.

# Sitemap

Every public site should have `sitemap.xml`.

For Next.js App Router, prefer:

`app/sitemap.ts`

Do not maintain a static XML manually if routes can be generated in code.

Include public indexable pages.

Exclude:
- admin;
- dashboard;
- API;
- private/auth;
- noindex pages.

New public pages should enter the sitemap automatically whenever practical.

# Technical SEO

OLNOO Admin should automatically check Projects for at least:
- Site status;
- Sitemap status;
- number of URLs in sitemap;
- Last checked.

Do not hardcode site lists.

A new Project should automatically enter common checks.

`robots.txt` is not currently mandatory for the OLNOO SEO workflow unless needed.

# Search engines

Minimum for public sites:
- Google Search Console;
- Yandex Webmaster;
- Bing Webmaster Tools;
- sitemap.xml.

Do not add many extra search engines without a practical reason.

IndexNow may be added later if it reduces manual work.

# OLNOO Admin

Repo: `RomanVaskin/olnoo-admin`  
Mac: `~/projects/olnoo-admin`  
KZ: `/opt/olnoo/projects/olnoo-admin`

OLNOO Admin is the unified platform.

Core entities:
- Clients
- Projects

Modules:
- SEO
- CRM
- Social
- Ads
- Analytics

Use existing PostgreSQL. Do not bring Supabase back unless explicitly needed.

All site modules should derive project lists from `Projects`, not hardcoded domains.

# OLNOO.com

Repo: `RomanVaskin/olnoo`  
Mac: `~/projects/olnoo`  
KZ: `/opt/olnoo/projects/olnoo`

Main areas:
- Growth
- AI & Automation
- Software & SaaS
- Global Business
- Telegram automation

Preserve:
- RU/EN routing;
- canonical;
- hreflang;
- sitemap;
- existing contact flow;
- Resend.

# CRM direction

CRM is live in production, not an MVP goal. Current flow:

`olnoo.com` contact form → shared Postgres (`leads` table) → `admin.olnoo.com` CRM (Overview + Leads).

See `OLNOO_PROJECT_MAP.md` for exact tables, routes, and fields. Do not re-derive the schema — it does not include `phone`; do not add it without a real requirement.

Statuses:
- New
- In progress
- Proposal
- Won
- Lost

Goal: connect marketing source to leads and deals.

# SEO ↔ CRM

SEO should eventually be measured by business outcomes, not only rankings.

Target chain:

**Cluster → Landing page → Traffic → Leads → Deals → Revenue**

# Social

Develop after SEO + CRM.

Goal:

Page/case/service → AI content → relevant channels → UTM → traffic → lead → CRM.

Avoid manually writing repetitive content for every client if it can become a reusable content engine.

Next integration plan: generate variants through the OLNOO AI Router → human review → Ready → automated posting through each platform's own API. Telegram and VK are connected (Bot API `sendMessage`, VK API `wall.post` — see `OLNOO_PROJECT_MAP.md`); Instagram/Threads have no platform API yet and stay manual "Mark as published". Roll platforms out one at a time, in this order: Telegram → VK → Instagram → Threads.

UX principle: Social must lead the user through one simple flow — Create content → adapt if needed → review → ready → publish → result. The user should never need to understand the underlying tables or API to use it.

# Ads

Develop after stable landing pages, CRM, and attribution.

Do not rebuild Yandex Direct/Google Ads from scratch.

Start with:

Landing → Campaign → UTM → Leads → CRM

Optimize based on leads/deals, not only clicks.

# Analytics

Analytics should unify:

SEO + traffic + social + ads + leads + sales

Goal: one clear business-result view.

Do not build a large BI platform too early.

# AI Router

OLNOO AI Router should be the unified model access layer.

Apps should describe the task; the Router should decide the model based on:

**capability → quality → cost → provider health → privacy**

Do not duplicate provider selection logic in every application.

Target features:
- provider registry;
- model capabilities;
- routing policy;
- fallback;
- health;
- cost/tokens;
- latency;
- error classification.

Do not log sensitive document content.

# AI Router providers

Potential providers:
- OpenAI
- Gemini
- DeepSeek
- Anthropic
- local tools/models

Do not choose by price alone.

Examples:

Simple classification → cheap suitable model  
SEO clustering → strong reasoning model  
Document OCR → local OCR first, vision fallback  
Code → strong coding model

Fallback belongs in the Router, not each app.

# OCR

OCR is a reusable OLNOO service, not something to reimplement per project.

Preferred flow:

Document → normalization → local OCR → AI structuring/fallback if needed

Local OCR is the cheap first layer.

Vision models are fallback for difficult cases.

OCR failure must not block the user: manual entry must remain possible.

# Insurance

Develop reusable insurance flows.

Document → OCR → user confirmation/manual correction → application → payment → policy.

Do not make OCR a hard dependency.

# Property

Property is a separate real-estate platform.

Main entities:
- settlements;
- houses;
- plots;
- buyer;
- broker;
- developer;
- admin;
- leads.

SEO follows the same one-intent-one-page principle.

# Aura

Aura may be actively changed via Claude Web/GitHub by another user.

Before local work:
- verify checkout freshness;
- do not assume local main is current;
- do not overwrite unrelated remote/local changes.

For small technical changes, prefer the established Claude/GitHub flow when it is simpler.

# Marketing

Marketing may also be changed through Claude/GitHub.

Do not use a stale local checkout without checking.

Preserve design/content outside the exact task.

# Sportpolis

Prefer local repo → GitHub → KZ update/build/restart.

Do not edit production code manually unless needed for emergency configuration/secrets.

# Brand vs Design

Keep them separate:

`brand/` → logos, identity, brandbook  
`design/` → UI/UX, design system, components, templates

# External / client sites

For now, GitHub is the main application path for sites we manage.

Do not build GitLab/WordPress/Webflow/Tilda/SSH connectors until there is a real repeating client need.

SEO analysis can work without code access:

Domain → Sitemap → Pages → Semantics → Clusters → Improve/Create recommendations → Task

Code access is mainly needed to automatically apply and publish changes.

Possible future connection types:
- GitHub
- GitLab
- WordPress
- Webflow
- SSH
- manual

Implement only what is actually used.

# Tilda / no-Git sites

Initial mode:

Public site → SEO analysis → Clusters → Improve/Create tasks → manual CMS changes

Do not build Tilda browser-agent automation until repeated real client work justifies it.

# Product development principle

OLNOO should improve through its own use.

Build SEO module → use it on OLNOO → get results → use as a case → offer to clients.

Build CRM → use it for OLNOO leads → improve → offer to clients.

Build Social → use it to promote OLNOO → improve → offer to clients.

Each new module should:
1. automate OLNOO;
2. help attract clients;
3. become a reusable product capability.

# Main goal

OLNOO must not become a business where:

more clients → proportionally more people → proportionally more manual work.

Target:

more clients → more automation → more reusable capabilities → less manual time per client → stronger product.
