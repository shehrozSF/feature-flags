-- One webhook per project (ADR 0039): where flag-change events are POSTed, and the
-- secret they are signed with. The secret is stored as-is because the API must sign
-- with it; it is shown to the owner only when set. Expand-only (ADR 0035): a new
-- table, so the previous Worker version keeps working after a rollback.
CREATE TABLE webhooks (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  url        text NOT NULL CHECK (char_length(url) BETWEEN 1 AND 2048),
  secret     text NOT NULL CHECK (secret ~ '^whsec_[0-9A-Za-z]{43}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
