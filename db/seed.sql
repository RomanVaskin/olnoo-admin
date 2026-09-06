-- OLNOO Admin — seed data for the first two real SEO projects.
-- Safe to re-run: uses ON CONFLICT DO NOTHING against the unique keys
-- added in 0001_init.sql (clients.name, projects.domain).

INSERT INTO clients (name, contact, status) VALUES
  ('OLNOO', 'Internal', 'active'),
  ('Aura Estate', 'Internal', 'active')
ON CONFLICT (name) DO NOTHING;

INSERT INTO projects (client_id, name, domain, sitemap_url, status)
SELECT c.id, 'OLNOO', 'https://olnoo.com', 'https://olnoo.com/sitemap.xml', 'Pending'
FROM clients c WHERE c.name = 'OLNOO'
ON CONFLICT (domain) DO NOTHING;

INSERT INTO projects (client_id, name, domain, sitemap_url, status)
SELECT c.id, 'Aura Estate', 'https://aura.olnoo.com', 'https://aura.olnoo.com/sitemap.xml', 'Pending'
FROM clients c WHERE c.name = 'Aura Estate'
ON CONFLICT (domain) DO NOTHING;
