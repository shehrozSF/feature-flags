CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  owner_id       uuid NULL,                 -- NULL = anonymous sandbox; set when claimed (Milestone 3)
  version        bigint NOT NULL DEFAULT 1, -- bumped on every flag change; used as ETag
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NULL           -- NULL = never (owned projects); sandboxes: last_active_at + 30 days
);

CREATE INDEX projects_expires_at_idx ON projects (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX projects_sandbox_activity_idx ON projects (last_active_at) WHERE owner_id IS NULL;
