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
