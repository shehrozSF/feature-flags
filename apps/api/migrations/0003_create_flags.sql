CREATE TABLE flags (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name          text NOT NULL,
  description   text NOT NULL DEFAULT '',
  enabled       boolean NOT NULL DEFAULT false,
  variants      jsonb NOT NULL,             -- [{ "key": "on", "value": true }, ...]
  off_variant   text NOT NULL,
  rules         jsonb NOT NULL DEFAULT '[]',
  default_serve jsonb NOT NULL,
  salt          text NOT NULL,              -- random per flag; makes buckets independent across flags
  version       integer NOT NULL DEFAULT 1, -- optimistic concurrency
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz NULL,
  UNIQUE (project_id, key),
  CHECK (jsonb_typeof(variants) = 'array'),
  CHECK (jsonb_typeof(rules) = 'array'),
  CHECK (octet_length(rules::text) <= 32768)
);
