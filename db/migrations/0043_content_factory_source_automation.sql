-- Apply once BEFORE this code; no existing source is enabled for automatic processing.
BEGIN;
CREATE FUNCTION content_factory_telegram_key(value TEXT) RETURNS TEXT
  LANGUAGE SQL IMMUTABLE STRICT AS $$
  SELECT substring(lower(btrim(value)) FROM '^(?:(?:https?://)?t[.]me/(?:s/)?|@)?([a-z0-9_]{5,32})(?:/[0-9]+)?/?$')
$$;
ALTER TABLE content_factory_sources
  ADD COLUMN automation JSONB NOT NULL DEFAULT '{"mode":"manual","accountId":null,"dailyLimit":3,"mediaRightsConfirmed":false}'::jsonb,
  ADD COLUMN automation_revision TEXT NOT NULL DEFAULT '',
  ADD COLUMN automation_runtime JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT content_factory_source_automation_object CHECK (jsonb_typeof(automation) = 'object' AND jsonb_typeof(automation_runtime) = 'object');
-- Non-unique deliberately: keep existing duplicate rows and all their materials/history.
CREATE INDEX content_factory_source_identity_idx ON content_factory_sources
  (project_id, content_factory_telegram_key(handle)) WHERE type = 'telegram';
ALTER TABLE content_factory_items
  ADD COLUMN automation JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(automation) = 'object'),
  ADD COLUMN automation_message_key TEXT;
CREATE UNIQUE INDEX content_factory_automation_message_idx ON content_factory_items(project_id, automation_message_key)
  WHERE automation_message_key IS NOT NULL;
COMMIT;
