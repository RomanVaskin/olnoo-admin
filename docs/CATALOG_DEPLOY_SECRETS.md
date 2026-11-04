# Catalog read token delivery through existing deploy

This PR prepares deployment only. It does not run a workflow or change production, systemd, nginx or the database. Migration 0039 must not be rerun.

## GitHub secret

`CATALOG_SITE_TOKENS` in RomanVaskin/olnoo-admin must be a JSON object containing `istraart` and any other configured project slugs. Every token must be a distinct 32–256 character printable ASCII string without spaces/control characters. Pretty/multiline JSON is accepted. The istraart token must exactly match the IstraArt repository's `OLNOO_CATALOG_TOKEN`. Values are never printed or fetched for comparison.

The workflow validates this secret and the existing Direct/Metrika secrets before SSH delivery. Existing Yandex delivery to `.env.production.local`, build and restart steps are unchanged. `.env.local` is not overwritten. No catalogue key is inserted into the Yandex file.

## Transport and runtime

A Node helper serializes the validated value as JSON (no shell interpolation or dotenv parsing). A private runner temp file is sent over SSH stdin, removed by a trap, and never uploaded as an artifact. The server uses an app-directory temp file with umask 077, validates the payload before an atomic rename to `.env.catalog.json`, and removes failed temp files. OLNOO preserves the existing `.env.local` owner/mode convention for the installed file without reading its contents. The file lives outside public/ and is ignored by Git.

`next.config.mjs` loads that file from its own directory on BOTH `next build` and `next start`, assigning only CATALOG_SITE_TOKENS to the server process. It does not use Next's `env` option or NEXT_PUBLIC keys. The file persists after the Actions process exits; startup therefore does not depend on the runner environment. An invalid installed file stops configuration loading with a generic error. Missing file is allowed for local development/legacy installs; a production workflow with a missing/invalid GitHub secret fails before deployment.

## Merge order

1. Merge this OLNOO delivery PR and wait for its existing deploy workflow to succeed.
2. Merge the separate IstraArt credentials-delivery PR and wait for deployment.
3. Merge IstraArt PR #7; its unchanged server catalog client then receives the already-delivered credentials.

The IstraArt delivery changes do not touch PR #7's UI/catalog files. After the third deploy, separately verify unpublished cards/photos remain unavailable and published istraart data is readable through both authentication layers. This PR performs no live integration test or deploy.

## Checks

`node --test scripts/catalog-deploy-env.test.mjs` tests JSON/punctuation round trips, missing/invalid-secret refusal without value output, atomic installation, failed-transfer rollback, unchanged existing env files and fresh-process runtime loading through next.config. Also validate deploy.yml with actionlint, run bash -n on run blocks, check the existing Yandex/build/restart steps remain identical, and scan a build with synthetic markers for leaks under .next/static. Only synthetic test values are used.
