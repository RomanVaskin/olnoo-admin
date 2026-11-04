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

The public export DTO retains its existing fields and adds only optional
`relatedCards` (contract below): one published row = one card with its own ID and
selected original photos. New rows export only their own offer;
legacy rows export as before. Neither source IDs, the internal parent field nor
draft relations are exposed. Each photo request still checks that exact card's publication,
project token and selected indices, even when another card shares the source.
Basic Auth, token binding, manual approval and no-store are unchanged. The editor
shows the existing `https://istraart.ru/#catalog` link only for a published card;
the current site has no individual product URL, so no fictitious permalink is
introduced. No IstraArt site change is required for this DTO.

### Public API: optional relatedCards

`GET /api/catalog/export` keeps the existing `{ project, cards }` response and
all prior card fields. Independent cards may additionally contain:

```json
{
  "relatedCards": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "slug": "source-material",
      "title": "Исходный материал",
      "type": "raw"
    }
  ]
}
```

Each summary has ONLY `id` (catalog card UUID), `slug`, `title`, and `type`
(`raw | finished | guide`). There are no URLs, recursive relations, source item
IDs, Telegram metadata, storage paths, or internal `parent_card_id` fields.
Existing IstraArt clients may ignore this optional field; no site change is made.
The field is omitted when there are no eligible relations, and on legacy cards.
Legacy combined offers are preserved, not guessed into separate typed cards.

Relations are resolved from the same already project-scoped query and only from
cards that pass the full existing public projection (published, own origin,
complete offers/photos and no media error). Source identity and project must both
match; unpublished, malformed, foreign-project and other-source candidates
cannot appear in related summaries:

| Card type | relatedCards |
| --- | --- |
| finished | All published `raw` cards of its source, and published `guide` cards whose parent is this exact product |
| raw | All published `finished` cards of its source |
| guide | Its corresponding published `finished` parent and published `raw` cards of its source |

No sibling product/guide is inferred merely from a shared source. A published
guide whose parent is a draft does not disclose that parent's UUID, slug or title.
Unpublish removes the card both from top-level export and from relatedCards on
subsequent no-store requests. Photo access is unchanged and still checked for the
requested published card. No extra migration, query per card, token or permission
bypass is introduced.

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

## Manual ChatGPT workflow — IstraArt Style v1 (0042; not deployed)

This PR is based on 0040/main and does **not** depend on the image-API PR #110 or
its 0041 migration. No AI API is invoked. Existing Telegram intake, Social,
Quality Gate, prices and manual publication remain unchanged.

### Owner flow

1. Projects → edit the existing `istraart` project → **IstraArt Style v1**.
   There is exactly one editable prompt, saved on that project. An unset value
   reads the one code-defined default; empty or >16,000-character saves fail.
   No style library, version registry or style selector is introduced.
2. Content Factory → own material → catalog card. Create/save a draft if needed.
   **Скопировать промпт для ChatGPT** combines the saved style with the selected
   raw/finished/guide task, current editable title/description, owner-entered
   dimensions and original owner text. Legacy cards allow choosing the task.
   Card prices/stock are not inferred or filled. Unknown dimensions are explicitly
   unknown. Attach reference photos in ChatGPT manually; private OLNOO URLs and
   secrets are not placed in the prompt. Clipboard failure leaves a readable
   text preview for manual copying.
3. The one style specifies Premium Minimalism / Japandi / Quiet Luxury, natural
   wood/stone/linen, muted beige palette, warm natural light, premium realistic
   product photography and 4:5 images without text/prices/logos/watermarks/collages.
   Raw material uses #F5F5F3 and a soft shadow while retaining wood geometry and
   texture; finished work uses the actual material reference and confirmed sizes;
   DIY asks for clear text instructions and separate illustrations, without
   invented technical specifications. Owner review is required for the manual
   ChatGPT result; an AI concept does not establish that an object was built.
4. In the saved target card, choose **real photo / AI visualization** explicitly
   and a photo position (1–10), then either upload JPEG/PNG/WebP directly from
   Admin, or send photos to the existing bot, choose IstraArt there and select
   that own material/photo using **Выбрать фото из Telegram** in Admin. Preview
   the Telegram photo and attach it to this card. No bot command/menu is changed.
5. In the enabled offer, check the position and choose the intended file from
   its variants. Upload/attachment does not auto-select or publish anything.
   Save confirmed description/price/availability and use the existing manual
   publish action. Multiple finished products and optional related raw/guide
   cards retain their own independent file selections and statuses.

### Storage, contract and access

- Migration 0042 adds `projects.istraart_style_prompt` (one text value) and
  `catalog_cards.manual_media` / `manual_photo_selection` (JSON metadata only).
  Photo bytes remain in the existing gitignored uploads filesystem.
- New files are immutable original uploads under
  `uploads/catalog/<projectId>/<cardUUID>/<photoUUID>.<jpg|png|webp>`, mode 0600.
  Image decoding validates the file but does not re-encode/crop/resize it.
  Telegram imports copy original bytes, retain source item/index provenance and
  never change the original Content Factory files. Real/AI classification is an
  explicit owner declaration stored on each upload, not an automatic detector.
- Each of the existing ten public photo positions can retain multiple variants;
  source originals remain available separately. The owner explicitly maps a
  position to a file on this exact card; otherwise an existing source photo is
  used. Files from other cards/projects cannot be selected by a guessed UUID.
  No delete/overwrite operation or separate media library is added.
- Internal settings API: GET/PUT `/api/projects/istraart-style?project=istraart`
  (`{ prompt }`). Internal media: GET/POST
  `/api/catalog/cards/<id>/media?project=istraart`; POST is bounded multipart
  `{ file, kind: real|ai, slot: 0..9 }` or JSON Telegram import
  `{ itemId, index: 0..9, kind, slot }`. Private preview:
  `/api/catalog/cards/<id>/media/<photoUUID>?project=istraart`.
  All stay behind existing Admin external Basic Auth; POST/PUT refuse a foreign
  Origin. Server queries check the project, own-source origin, target card and
  source/photo identity. Bodies are bounded, only actual static JPEG/PNG/WebP
  <=10 MB / 40 MP are accepted; SVG/PDF/animation/arbitrary URLs are rejected.
- Public catalog DTO, relatedCards and photo URLs stay unchanged. The existing
  protected export handler resolves the selected file for the requested published
  card/index with the same project-bound token checks and no-store. Internal
  media/provenance/selection data is not serialized. The classification is visible
  in Admin; this PR does not change IstraArt site labels or Social integration.
  Owners should describe AI concepts accurately before approving public copy.
- Appending an upload never changes offers, price or publication. Only explicit
  selection/save changes a card's chosen photo; saving a published card retains
  the prior manual-update behavior. Errors preserve original/previous files;
  failed pre-commit writes roll back. An uncertain COMMIT retains the new file
  instead of deleting a potentially committed reference (operator review may be
  needed for an unreferenced file after a connection failure).

### Release order — operator only, not executed

1. Review this PR and create a backup by the existing PostgreSQL process.
   Confirm prerequisite 0040 is installed; do not rerun 0039/0040. 0041 is reserved
   for the separate API-processing PR and is **not** a prerequisite here.
2. On **KZ**, `/opt/olnoo/projects/olnoo-admin`, with the existing DATABASE_URL
   configured in a trusted shell, extract and apply the reviewed 0042 once,
   **before deploying this code**:

   ```bash
   cd /opt/olnoo/projects/olnoo-admin
   git fetch origin feat/istraart-manual-catalog
   git show origin/feat/istraart-manual-catalog:db/migrations/0042_istraart_manual_catalog.sql > /tmp/olnoo-0042-manual.sql
   test -n "$DATABASE_URL"
   psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f /tmp/olnoo-0042-manual.sql
   ```

3. Verify the three columns/defaults/CHECKs and unchanged prior card/publication
   data against the backup. If SQL fails, stop; its transaction rolls back.
4. Only with separate approval merge/deploy, then accept the owner flow with a
   real material/product/guide, actual clipboard/browser upload, existing bot and
   site export. No migration, server config, secret, merge or deploy is performed
   by this PR.

Local checks: TypeScript, `lib/istraart-manual*.test.ts`, catalog/Content Factory
profile tests, build and `git diff --check`. Tests cover saved prompt/clipboard,
exact file bytes, Telegram import, explicit real/AI kinds, cross-project/card/file
rejection, publication defaults and old DTO/photos. SQL fixture
`db/tests/istraart_manual_catalog.sql` is ONLY for a disposable DB (executed locally
in PGlite/PostgreSQL WASM), preserving old rows and checking constraints without
0041. No real ChatGPT generation, Telegram delivery, live KZ or browser acceptance
is claimed by synthetic local tests.

### PR #111 runtime failures: diagnosis and recovery

The deploy workflow builds/restarts Admin; success does not prove that 0042 was
applied. These queries depend on it:

| 0042 column | Dependent functionality |
| --- | --- |
| `projects.istraart_style_prompt` | Project style GET/PUT; card ChatGPT prompt/copy |
| `catalog_cards.manual_media` | Card list/editor; upload/import/private preview; export/photo relay |
| `catalog_cards.manual_photo_selection` | Card list/save; explicit photo selection; export/photo relay |

Confirmed in code and regression tests: a missing column causes PostgreSQL 42703,
previously an unhandled API failure. A failed card GET left `loaded=false`, so
creation/editing was disabled; the blank draft still displayed publication field
errors. Failed prompt GET left copy/save disabled, hid the API diagnostic and
provided no retry. These symptoms do **not** confirm the live KZ schema or prove
that every reported production failure has this cause.

Known missing 0042 columns now return uncached HTTP 503 with
`code: CATALOG_MIGRATION_REQUIRED` and a safe operator message. No database details
or secrets are returned, no empty card/default prompt is substituted for a schema
failure. Other failures retain their original behavior. Existing external Admin
protection, project-bound export authorization and publication checks remain.
The editor hides an unloaded form, reports field errors on explicit save and offers
retry; both style controls offer retry and surface the safe API error (auth
failures are distinguished). This does not make missing columns optional.

**Operator actions still required, separately authorized:** inspect KZ API status
and application logs, verify existing 0040, and check all three 0042 columns,
defaults and CHECK constraints. If absent, apply the unchanged transactional
`0042_istraart_manual_catalog.sql` once through the existing backed-up DB process,
then retry prompt/cards and accept the real upload/copy/edit/publish flow. If the
columns already exist, investigate the actual failing response/log instead of
rerunning SQL. Do not apply 0041/PR #110 for this feature. No production/schema
check or migration was executed as part of this fix; local handler/UI tests
simulate missing/available schema without connecting to a database.


### IstraArt Style PUT behind nginx

The prompt PUT permits an Origin equal to the request URL origin (existing direct
same-origin behavior) or exactly `https://admin.olnoo.com`, the external Admin
origin recorded in the production map. This avoids rejecting the owner when
nginx terminates HTTPS and Next.js sees an internal HTTP URL. Foreign origins,
lookalike domains, different ports and `Origin: null` remain rejected before any
DB write. `Forwarded` / `X-Forwarded-*` headers never expand this allowlist; no
proxy configuration change or implicit trust in unverified headers is required.
Requests without Origin retain their existing behavior. External Basic Auth,
project scope and schema checks remain unchanged. Handler tests reproduce the
internal/public URL mismatch; live proxy request headers were not inspected.
