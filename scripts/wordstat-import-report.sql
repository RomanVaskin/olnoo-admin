-- Read-only report: Wordstat imports into one project on one day, grouped by operation, with the
-- facts needed before moving them elsewhere. Writes nothing. Works with or without migration 0011.
--
--   psql "$DATABASE_URL" -v slug=olnoo -v day=2026-10-02 -v target=driveset -f scripts/wordstat-import-report.sql
--
-- An import writes its keywords and its imports rows in one transaction and now() is the
-- transaction start, so keywords.created_at = imports.created_at identifies exactly the keywords
-- that import CREATED; updated_at = imports.created_at with an older created_at marks keywords
-- that already existed and only had their frequency overwritten. Across several operations of
-- the day, a keyword created by an earlier one of them is not a conflict (it is from the same
-- mistake); only keywords older than all of them are (never auto-deleted).

\set ON_ERROR_STOP on

\echo '== Imports per operation'
SELECT i.created_at AS operation_ts,
       count(*) AS files,
       sum(i.rows_count) AS file_rows,
       (SELECT count(*) FROM keywords k WHERE k.project_id = i.project_id AND k.created_at = i.created_at) AS created_keywords,
       (SELECT count(*) FROM keywords k WHERE k.project_id = i.project_id AND k.updated_at = i.created_at
          AND k.created_at < i.created_at) AS overwritten_older_keywords,
       string_agg(i.file_name, ', ' ORDER BY i.id) AS file_names
FROM imports i
JOIN projects p ON p.id = i.project_id
WHERE p.slug = :'slug' AND i.created_at >= :'day'::date AND i.created_at < :'day'::date + 1
GROUP BY i.project_id, i.created_at
ORDER BY i.created_at;

\echo '== Totals over those operations'
WITH ops AS (
  SELECT DISTINCT i.project_id, i.created_at FROM imports i JOIN projects p ON p.id = i.project_id
  WHERE p.slug = :'slug' AND i.created_at >= :'day'::date AND i.created_at < :'day'::date + 1
), created AS (
  SELECT k.* FROM keywords k JOIN ops ON ops.project_id = k.project_id AND k.created_at = ops.created_at
), linked AS (
  SELECT c.id FROM created c
  WHERE EXISTS (SELECT 1 FROM seo_cluster_keywords sk WHERE sk.keyword_id = c.id)
     OR EXISTS (SELECT 1 FROM keyword_pages kp WHERE kp.keyword_id = c.id)
     OR EXISTS (SELECT 1 FROM seo_clusters s WHERE s.primary_keyword_id = c.id)
)
SELECT (SELECT count(*) FROM ops) AS operations,
       (SELECT count(*) FROM created) AS created_unique_keywords,
       (SELECT count(*) FROM linked) AS created_but_linked_to_clusters_or_pages,
       (SELECT count(DISTINCT k.id) FROM keywords k JOIN ops ON ops.project_id = k.project_id
          AND k.updated_at = ops.created_at AND k.created_at < ops.created_at
          WHERE NOT EXISTS (SELECT 1 FROM ops o2 WHERE o2.project_id = k.project_id AND o2.created_at = k.created_at)
       ) AS preexisting_overwritten,
       (SELECT count(*) FROM created c JOIN keywords t ON t.query = c.query AND COALESCE(t.region, '') = COALESCE(c.region, '')
          JOIN projects tp ON tp.id = t.project_id AND tp.slug = :'target') AS already_in_target;

\echo '== Keywords that existed before all those operations and were overwritten (conflicts, first 50)'
WITH ops AS (
  SELECT DISTINCT i.project_id, i.created_at FROM imports i JOIN projects p ON p.id = i.project_id
  WHERE p.slug = :'slug' AND i.created_at >= :'day'::date AND i.created_at < :'day'::date + 1
)
SELECT DISTINCT k.query, k.region, k.frequency AS frequency_now, k.created_at
FROM keywords k
JOIN ops ON ops.project_id = k.project_id AND k.updated_at = ops.created_at AND k.created_at < ops.created_at
WHERE NOT EXISTS (SELECT 1 FROM ops o2 WHERE o2.project_id = k.project_id AND o2.created_at = k.created_at)
ORDER BY k.query
LIMIT 50;
