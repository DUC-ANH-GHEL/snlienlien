-- Wishes guestbook schema (Neon Postgres)

CREATE TABLE IF NOT EXISTS wishes (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wishes_created_at_idx ON wishes (created_at DESC);
