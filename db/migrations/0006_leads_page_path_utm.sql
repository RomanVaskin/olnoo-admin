-- OLNOO Admin — CRM leads: preserve page path and full UTM set from public sites
-- Applied manually. Not run automatically against production.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS page_path TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_content TEXT NOT NULL DEFAULT '';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS utm_term TEXT NOT NULL DEFAULT '';
