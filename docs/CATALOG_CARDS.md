# Catalog cards — IstraArt MVP (implementation stage A)

## Scope
The already existing Telegram owner-material intake (via `@olnoo_social`) stores photos in
`content_factory_items`. It is **not** a shop. The additive migration
`db/migrations/0039_catalog_cards.sql` adds one structured card per owner-uploaded
natural find, scoped to the existing OLNOO project. It does not add a bot, a database,
a server, or a second source of photo truth.

A catalog card has three optional offer keys in one `offers` object:
`raw` (the natural material), `finished` (the finished product),
`guide` (DIY instructions). Each offer holds a confirmed price in RUB, availability,
title, description, and indices of original photographs. Uncreated offers stay absent.
No AI-generated price/stock/PDF is allowed.

## Internal endpoints (under existing Admin external authentication)
- `GET /api/catalog/cards?project=istraart` lists internal records.
- `POST /api/catalog/cards?project=istraart` accepts
  `{ "contentItemId": "<existing owner item id>", "card": { "slug": "koryaga-001", "title": "Коряга №001", "description": "", "lengthCm": 30, "diameterCm": 5, "offers": { "raw": { "title": "Заготовка", "description": "", "priceRub": 1500, "available": true, "imageIndexes": [0] } } } }`.
- `PATCH /api/catalog/cards/<card-id>?project=istraart`: `{ "card": <whole card> }`,
  `{ "action": "publish" }`, or `{ "action": "unpublish" }`.
- Publication is an explicit human action. Database migration is required **before** deploying these routes. No production DB migration has been executed in this PR.

## Deliberately not included
No public endpoint, public images, browser access bypass, site integration, UI, PDF
payment, image generation, or direct deploy. External access to `admin.olnoo.com`
is externally protected and must be tested before choosing a public read-only adapter.
The next PR must provide a safe public projection (published records only),
secure image serving and site integration; until then the site remains unchanged.

## Verification
Run `node --test --experimental-strip-types lib/catalog-card.test.ts` and
`pnpm exec tsc --noEmit`, `pnpm build` when dependencies are available.
No DB integration was tested without the migration being applied to a disposable database.

## Stage B: editor and site export (repository changes, no deploy)
- Own Content Factory material cards contain the catalog editor, with separate optional raw/finished/guide fields and photo selection from that material. No demo price/availability is generated. Publish requires at least one complete offer (description, positive confirmed RUB price, explicit availability, at least one readable original photo). Missing offers stay absent. Published-card edits must remain complete; saving updates the same row. Concurrent changes require reload via updated_at snapshot comparison. Unpublish removes the card from export.
- `GET /api/catalog/export` and `GET /api/catalog/export/<cardUUID>/photos/<index>` remain behind existing external Admin authentication. They additionally require `X-Olnoo-Catalog-Token`, bound server-side to exactly one project by `CATALOG_SITE_TOKENS` JSON map. Empty/invalid/reused-token maps fail closed. Browser clients never receive this key.
- Export is a strict whitelist of published cards, confirmed offers and selected photo indices. Photos recheck publication, project, owner origin and used indices on every request. No source text, item IDs, storage paths, arbitrary uploads or PDFs are exported. Data/photos are no-store. Already downloaded public content cannot be recalled, but new requests after unpublish cannot retrieve it.
- IstraArt server calls these routes with its read-only project key and the existing external Basic Auth credentials (Authorization Basic plus the separate custom catalog header), then proxies only the published image bytes to visitors. No nginx exception, public opening of internal Admin APIs, shared browser secret, separate database or photo copy is required. Server variables must be configured by the operator through the existing secret mechanism; neither PR changes production/configuration.
- Owner confirmed migration 0039 applied on KZ and table/four indexes/trigger verified. Do not reapply it for this stage. No additional migration is introduced.
- Local tests cover draft/foreign project selection, token binding, unused photo denial, partial offers, whitelist and same-ID edits. No live Basic Auth/site/Telegram end-to-end check has been performed from this environment; perform after separately approved deployment and server secret setup.

## Editor UX and validation (repository change, not deployed)
- A new owner-material card suggests an editable title from the first source-text line
  (then owner brief / generated title as fallbacks) and a Latin slug with an item-ID
  suffix. It does not infer prices, availability, dimensions, or create offers.
- The drawer separates **Каталог сайта IstraArt** from **Социальные сети**. Saving
  a new card keeps it a **Черновик**. **Опубликовать на сайте** is the explicit human
  approval action; **Опубликовано на сайте** shows a link to
  `https://istraart.ru/#catalog`. Social preparation, account choice, approval and
  publication remain independent and retain their Quality Gate.
- `catalogCardErrors` is shared by the client and write APIs. Validation errors use
  `fieldErrors` keyed by field path (for example `offers.raw.priceRub`), displayed
  next to the corresponding input. New offers require an explicit availability
  choice. Publication requires a confirmed positive price, description and selected
  readable original photo for every enabled offer. Drafts can omit descriptions
  and photos; published-card edits must stay complete. Fix fields and save before
  publishing. Saving a published card updates the existing site card; unpublish
  removes it from subsequent exports.
- No schema, migration, export access policy or production configuration changes.
  Local handler tests use isolated DB/file substitutes for raw and finished
  materials: create/save/reload/edit/publish/unpublish, field errors, foreign project
  denial and unreadable-photo denial. These are representative fixtures, not live
  Telegram examples. Real source materials and live site acceptance still require
  a separate post-deployment check; no production write is performed here.

## Independent product cards (migration 0040; not deployed)

One owner-uploaded Content Factory item can now have any number of catalog rows.
The existing editor lists all its cards. **Создать изделие** creates a `finished`
card; optional **Создать карточку исходного материала** and **Создать DIY-гайд для
изделия** create separate `raw` and `guide` drafts in the same transaction. If any
insert fails, the bundle is rolled back. A raw card can also be created separately;
a saved finished card offers a button to create a guide later. All options are off
by default. No price, availability, characteristics or photography is generated.

Each row retains its own UUID, project-unique slug, title/description, offer
price/availability/photo selection and `published_at`. New rows use the existing
`offers` JSON with at most one key matching `card_kind`. An empty draft can have
no offer. Publication still requires complete confirmed fields and readable
original photos, followed by the explicit **Опубликовать на сайте** action. A
product does not require a raw card or guide; publishing/unpublishing it does not
change the others. Guide publication does not require its parent to be published.

`content_item_id` links every card to its original own material. Guide-only
`parent_card_id` links to a `finished` card of the same project AND source. The API
checks this scope; the DB trigger, FK and CHECK constraints enforce it as well.
Source, project, type and parent are immutable after creation. Photos remain
indices into the unchanged source media; no duplicate storage or processing.

Existing rows become `card_kind=legacy`, preserving ALL existing UUIDs, slugs,
offers, timestamps and publication status. They retain the three-offer editor.
Old POST clients that omit `cardKind` retain legacy behavior (one legacy card per
source through a partial unique index). New editor calls use explicit types.
No automatic splitting, duplication, reapproval or publication of legacy data.

Internal API additions:
- GET `/api/catalog/cards?project=istraart` also returns `card_kind` and
  `parent_card_id` for the selector and internal relation display.
- POST accepts `cardKind: finished|raw|guide|legacy`, optional `parentCardId`
  (required ONLY for guides), and optional boolean `createRaw` / `createGuide`
  (ONLY for finished cards). Main card fields remain in `card` as before.
  The response retains `id`, `slug`, `published_at` and includes `createdCards`.
- PATCH remains a card-content update or explicit publish/unpublish action;
  relation/type changes are rejected. Duplicate slug returns 409, with no partial
  bundle. Pressing save again with the same slug cannot create a duplicate.

The public export DTO remains unchanged: one published row = one card with its
own ID and selected original photos. New rows export only their own offer;
legacy rows export as before. Neither source IDs nor parent IDs/draft relations
are exposed. Each photo request still checks that exact card's publication,
project token and selected indices, even when another card shares the source.
Basic Auth, token binding, manual approval and no-store are unchanged. The editor
shows the existing `https://istraart.ru/#catalog` link only for a published card;
the current site has no individual product URL, so no fictitious permalink is
introduced. No IstraArt site change is required for this DTO.

### Exact migration/release order (operator only, KZ)

No production commands were run for this PR. Do NOT reapply or edit 0039.
0040 is a one-time transactional migration. Apply it **before** merging/deploying
this PR: the new GET/export reads the new columns. Existing deployed code remains
compatible with the schema addition and the legacy-source partial unique index.

1. Review this PR and obtain a PostgreSQL backup via the existing operator process.
2. On **KZ**, `/opt/olnoo/projects/olnoo-admin`, fetch the reviewed PR branch without
   checking it out or deploying it. In a shell with the existing DATABASE_URL
   connection configured (never print its value), extract the migration:

   ```bash
   cd /opt/olnoo/projects/olnoo-admin
   git fetch origin feat/catalog-independent-cards
   git show origin/feat/catalog-independent-cards:db/migrations/0040_catalog_independent_cards.sql > /tmp/olnoo-0040-catalog.sql
   test -n "$DATABASE_URL"
   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f /tmp/olnoo-0040-catalog.sql
   ```

3. Verify the schema, retained rows and guards (counts disclose no secret):

   ```bash
   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
   SELECT column_name, data_type, column_default FROM information_schema.columns
     WHERE table_name='catalog_cards' AND column_name IN ('card_kind','parent_card_id');
   SELECT card_kind, count(*) FROM catalog_cards GROUP BY card_kind;
   SELECT indexname, indexdef FROM pg_indexes WHERE tablename='catalog_cards';
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
     WHERE conrelid='catalog_cards'::regclass;
   SELECT pg_get_triggerdef(oid) FROM pg_trigger
     WHERE tgrelid='catalog_cards'::regclass AND NOT tgisinternal;
   SQL
   ```

   Expected: old rows are legacy with their prior count/status/data; the old full
   `(project_id, content_item_id)` uniqueness is replaced by
   `catalog_cards_legacy_source_idx`; source/parent indexes, parent FK, kind/offer
   CHECKs and `catalog_cards_project_guard` exist. Check the retained old IDs and
   published counts against the backup/pre-migration snapshot. If migration
   fails, its transaction rolls back: stop, do not deploy or rerun blindly.
4. Only after verification and separate approval, merge this PR and use the
   existing deployment mechanism. No automatic merge/deploy is part of this task.
5. Accept in Admin: two products from one source; optional raw/guide drafts;
   independent edits/photos/publication; guide relation; previous published card;
   draft/foreign/unused-photo access denied. Verify the site after deployment.

### Regression checks

`node --experimental-strip-types --test lib/catalog-*.test.ts
lib/content-factory-*.test.ts`, `tsc --noEmit`, `next build --webpack`,
`git diff --check`.

DB regression fixture: **only on a disposable test database**, run
`psql "$CATALOG_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f db/tests/catalog_independent_cards.sql`.
It creates its own fixture schema/tables, applies the original 0039, snapshots a
published legacy row, applies 0040 and tests multiple products, guide relations,
source/project/type rejection, immutable links, parent deletion protection,
unique slugs and independent publication. It must never be run on KZ production.
For this PR the same SQL was executed in isolated in-memory PGlite (PostgreSQL
WASM); no production DB/environment connection was used. API tests execute the
real handlers with isolated DB/file substitutes. Live Telegram, production Basic
Auth and site acceptance are not claimed by these local tests.
