-- Adds a nullable `channel` column to `leads`, separate from the existing `source`.
-- source = where the visitor came from (Ads/SEO/Direct/Referral/...), unchanged by this migration.
-- channel = how they got in touch (Form/Quiz/Telegram/Email/WhatsApp/MAX/Phone/...), stored as
-- plain text — no enum, no new table. Existing leads keep channel = NULL; no backfill.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS channel TEXT;
