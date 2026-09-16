-- Optional contact methods for inbound leads. Apply manually before the API patch.
-- Existing email and tracking columns/data remain unchanged.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS contact TEXT;
