-- Where a host or a team hears about bookings besides email: a Slack
-- incoming webhook or a Telegram bot. The destination (webhook URL, bot
-- token + chat id) is a secret and is stored encrypted, AAD-bound to the
-- row like calendar tokens; `label` is what the dashboard shows instead.
CREATE TABLE IF NOT EXISTS notification_channels (
  id            TEXT PRIMARY KEY,
  owner_kind    TEXT NOT NULL,            -- 'user' | 'team'
  owner_id      TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- 'slack' | 'telegram'
  label         TEXT NOT NULL,
  config_enc    TEXT NOT NULL,
  key_version   INTEGER NOT NULL,
  events_json   TEXT NOT NULL DEFAULT '[]',
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notification_channels_owner_idx ON notification_channels (owner_kind, owner_id);
