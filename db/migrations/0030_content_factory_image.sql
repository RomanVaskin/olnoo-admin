-- One optional original cover per Content Factory item. The file lives under the existing
-- gitignored uploads/ directory; only its generated filename is stored in Postgres.
ALTER TABLE content_factory_items ADD COLUMN IF NOT EXISTS image_filename TEXT NOT NULL DEFAULT '';
