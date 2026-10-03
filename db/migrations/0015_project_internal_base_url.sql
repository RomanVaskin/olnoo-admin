-- OLNOO Admin — optional internal base URL of a project's site (Pages sync only)
-- Applied manually. Not run automatically against production.
-- For a site deployed on the same server as Admin, e.g. 'http://127.0.0.1:3230': the Pages sync reads
-- the sitemap and the pages from it instead of the public domain (a server calling its own public
-- address is unreliable). NULL = use the public URLs, exactly as before. Additive, nullable.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS internal_base_url TEXT;
