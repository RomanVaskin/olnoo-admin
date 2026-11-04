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
