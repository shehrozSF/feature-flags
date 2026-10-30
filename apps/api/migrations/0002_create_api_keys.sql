CREATE TYPE api_key_kind AS ENUM ('admin', 'server', 'client');

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        api_key_kind NOT NULL,
  key_hash    bytea NOT NULL UNIQUE,        -- SHA-256 of the secret part
  key_prefix  text NOT NULL,                -- e.g. "ff_client_<projectId>_Zt7w" for display
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz NULL
);
