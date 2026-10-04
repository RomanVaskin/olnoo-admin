-- Attribution identifiers for leads (CRM attribution capture, step A1). All columns are nullable and
-- additive: existing rows and existing inbound clients (which do not send these) are unaffected.
--
-- Apply manually, BEFORE the deployment of the code that INSERTs into these columns — the deploy
-- workflow does not run migrations, and an INSERT naming a missing column would reject every lead.
--
--   lead_tracking_id   random UUID created by the client for one lead submission; the idempotency key
--   metrika_client_id  Yandex Metrika ClientID. TEXT on purpose: it is a UInt64 (up to 20 digits) and can
--                      exceed the JavaScript safe-integer range, so it must never travel as a number
--   yclid              Yandex Direct click id, when the landing URL carried one
--   first_seen_at      when the browser first recorded the visitor's first touch (client-reported time)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS lead_tracking_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS metrika_client_id TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS yclid TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;

-- A replayed submission must not create a second lead. Partial: leads without an id never collide.
CREATE UNIQUE INDEX IF NOT EXISTS leads_lead_tracking_id_uidx ON leads (lead_tracking_id) WHERE lead_tracking_id IS NOT NULL;
-- No index on metrika_client_id / yclid: the joins read a period-bounded, project-scoped set of leads
-- (already served by leads_project_id_idx); add one when a real lookup by these values appears.
