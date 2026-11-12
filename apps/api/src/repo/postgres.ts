// The only place SQL lives (ADR 0012). Rows are mapped to domain objects in
// one function, and the optimistic-concurrency check is a single UPDATE.
import type pg from 'pg';
import { ConflictError } from '../domain/errors';
import type { Flag } from '@ff/eval-core';
import type {
  FlagChanges,
  NewFlag,
  ProjectSnapshot,
  Repository,
  StoredFlag,
  StoredKey,
  StoredWebhook,
  WebhookInfo,
} from '../domain/ports';
import type { KeyKind } from '../keys';
import { holdClient } from './pg-client';

type Queryable = pg.Pool | pg.PoolClient;

/** pg_advisory_xact_lock key for sandbox creation (any fixed bigint). */
const SANDBOX_CREATION_LOCK = 7_341_200_001;

type FlagRow = {
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  variants: StoredFlag['variants'];
  off_variant: string;
  rules: StoredFlag['rules'];
  default_serve: StoredFlag['defaultServe'];
  salt: string;
  version: number;
  updated_at: Date;
  archived_at: Date | null;
};

const FLAG_COLUMNS = `key, name, description, enabled, variants, off_variant, rules,
  default_serve, salt, version, updated_at, archived_at`;

function toStoredFlag(row: FlagRow): StoredFlag {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    variants: row.variants,
    offVariant: row.off_variant,
    rules: row.rules,
    defaultServe: row.default_serve,
    salt: row.salt,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at ? row.archived_at.toISOString() : null,
  };
}

/** The evaluation-only view of a flag (what SDKs receive). */
function toFlag(f: StoredFlag): Flag {
  return {
    key: f.key,
    enabled: f.enabled,
    variants: f.variants,
    offVariant: f.offVariant,
    rules: f.rules,
    defaultServe: f.defaultServe,
    salt: f.salt,
    version: f.version,
  };
}

// Changeable fields → column names. jsonb values are sent as JSON strings,
// because pg would turn a JS array into a Postgres array, not JSON.
const CHANGE_COLUMNS: Record<keyof FlagChanges, { column: string; json: boolean }> = {
  name: { column: 'name', json: false },
  description: { column: 'description', json: false },
  enabled: { column: 'enabled', json: false },
  variants: { column: 'variants', json: true },
  offVariant: { column: 'off_variant', json: false },
  rules: { column: 'rules', json: true },
  defaultServe: { column: 'default_serve', json: true },
};

const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === '23505';

type WebhookRow = { url: string; secret: string; created_at: Date; updated_at: Date };
const toWebhook = (row: WebhookRow): StoredWebhook => ({
  url: row.url,
  secret: row.secret,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export class PostgresRepository implements Repository {
  constructor(
    private readonly db: Queryable,
    private readonly inTransaction = false,
  ) {}

  withTransaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    return this.transaction('BEGIN', fn);
  }

  async loadSnapshot(projectId: string): Promise<ProjectSnapshot | null> {
    // REPEATABLE READ: every query below sees the database as of the first one, so
    // a write committing in between can't pair an old version with newer flags.
    return this.transaction('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', async (tx) => {
      const projectVersion = await tx.projectVersion(projectId);
      if (projectVersion === null) return null;
      const flags: Record<string, Flag> = {};
      for (const f of await tx.listFlags(projectId)) flags[f.key] = toFlag(f);
      const { rows } = await tx.db.query<{ kind: KeyKind; hash_hex: string }>(
        `SELECT kind, encode(key_hash, 'hex') AS hash_hex FROM api_keys
         WHERE project_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`,
        [projectId],
      );
      return {
        ruleset: { projectVersion, flags },
        keys: rows.map((r) => ({ kind: r.kind, hashHex: r.hash_hex })),
      };
    });
  }

  private async transaction<T>(
    begin: string,
    fn: (tx: PostgresRepository) => Promise<T>,
  ): Promise<T> {
    if (this.inTransaction) return fn(this);
    return holdClient(this.db as pg.Pool, async (client, rollback) => {
      try {
        await client.query(begin);
        const result = await fn(new PostgresRepository(client, true));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await rollback();
        throw error;
      }
    });
  }

  async createProject(input: { name: string; expiresAt: Date | null }): Promise<{ id: string }> {
    const { rows } = await this.db.query<{ id: string }>(
      'INSERT INTO projects (name, expires_at) VALUES ($1, $2) RETURNING id',
      [input.name, input.expiresAt],
    );
    return rows[0]!;
  }

  async insertKey(
    projectId: string,
    key: { kind: KeyKind; secretHash: Uint8Array; prefix: string },
  ): Promise<void> {
    await this.db.query(
      'INSERT INTO api_keys (project_id, kind, key_hash, key_prefix) VALUES ($1, $2, $3, $4)',
      [projectId, key.kind, key.secretHash, key.prefix],
    );
  }

  async findKey(projectId: string, secretHash: Uint8Array): Promise<StoredKey | null> {
    const { rows } = await this.db.query<{ kind: KeyKind; revoked_at: Date | null }>(
      'SELECT kind, revoked_at FROM api_keys WHERE project_id = $1 AND key_hash = $2',
      [projectId, secretHash],
    );
    const row = rows[0];
    return row ? { kind: row.kind, revokedAt: row.revoked_at?.toISOString() ?? null } : null;
  }

  async setWebhook(projectId: string, url: string, secret: string): Promise<WebhookInfo> {
    // One statement, so two concurrent sets can't both insert: the second updates.
    const { rows } = await this.db.query<WebhookRow>(
      `INSERT INTO webhooks (project_id, url, secret) VALUES ($1, $2, $3)
       ON CONFLICT (project_id)
         DO UPDATE SET url = EXCLUDED.url, secret = EXCLUDED.secret, updated_at = now()
       RETURNING url, secret, created_at, updated_at`,
      [projectId, url, secret],
    );
    const { secret: _secret, ...info } = toWebhook(rows[0]!);
    return info;
  }

  async getWebhook(projectId: string): Promise<StoredWebhook | null> {
    const { rows } = await this.db.query<WebhookRow>(
      'SELECT url, secret, created_at, updated_at FROM webhooks WHERE project_id = $1',
      [projectId],
    );
    return rows[0] ? toWebhook(rows[0]) : null;
  }

  async deleteWebhook(projectId: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM webhooks WHERE project_id = $1', [
      projectId,
    ]);
    return (rowCount ?? 0) > 0;
  }

  async lockProject(projectId: string): Promise<void> {
    await this.db.query('SELECT 1 FROM projects WHERE id = $1 FOR UPDATE', [projectId]);
  }

  async projectVersion(projectId: string): Promise<number | null> {
    const { rows } = await this.db.query<{ version: string }>(
      'SELECT version FROM projects WHERE id = $1',
      [projectId],
    );
    return rows[0] ? Number(rows[0].version) : null;
  }

  async bumpProjectVersion(projectId: string): Promise<number> {
    const { rows } = await this.db.query<{ version: string }>(
      'UPDATE projects SET version = version + 1 WHERE id = $1 RETURNING version',
      [projectId],
    );
    return Number(rows[0]!.version);
  }

  async touchActivity(projectId: string, idleDays: number): Promise<void> {
    // The WHERE clause is the throttle: within the hour, nothing matches and
    // nothing is written. owner_id IS NULL: only sandboxes expire.
    await this.db.query(
      `UPDATE projects
          SET last_active_at = now(), expires_at = now() + $2 * interval '1 day'
        WHERE id = $1 AND owner_id IS NULL AND last_active_at < now() - interval '1 hour'`,
      [projectId, idleDays],
    );
  }

  async lockSandboxCreation(): Promise<void> {
    // A transaction-scoped advisory lock: released at COMMIT or ROLLBACK, so it
    // can't leak. The number is arbitrary; it only has to be the same everywhere.
    await this.db.query('SELECT pg_advisory_xact_lock($1::bigint)', [SANDBOX_CREATION_LOCK]);
  }

  async countSandboxes(): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      'SELECT count(*) FROM projects WHERE owner_id IS NULL',
    );
    return Number(rows[0]!.count);
  }

  async evictOldestSandbox(): Promise<string | null> {
    // Uses the partial index on last_active_at (owner_id IS NULL). id breaks ties.
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM projects
        WHERE id = (SELECT id FROM projects WHERE owner_id IS NULL
                    ORDER BY last_active_at, id LIMIT 1)
        RETURNING id`,
    );
    return rows[0]?.id ?? null;
  }

  async deleteExpired(limit: number): Promise<string[]> {
    // One statement, so the deletions are committed when it returns. Flags and
    // keys go with their project (ON DELETE CASCADE).
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM projects
        WHERE id IN (SELECT id FROM projects WHERE expires_at < now() ORDER BY expires_at LIMIT $1)
        RETURNING id`,
      [limit],
    );
    return rows.map((r) => r.id);
  }

  async rulesetBytes(projectId: string): Promise<number> {
    const { rows } = await this.db.query<{ bytes: string }>(
      `SELECT coalesce(sum(octet_length(variants::text) + octet_length(rules::text)
                           + octet_length(default_serve::text)), 0) AS bytes
         FROM flags WHERE project_id = $1 AND archived_at IS NULL`,
      [projectId],
    );
    return Number(rows[0]!.bytes);
  }

  async countActiveFlags(projectId: string): Promise<number> {
    const { rows } = await this.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM flags WHERE project_id = $1 AND archived_at IS NULL',
      [projectId],
    );
    return Number(rows[0]!.n);
  }

  async listFlags(projectId: string): Promise<StoredFlag[]> {
    const { rows } = await this.db.query<FlagRow>(
      `SELECT ${FLAG_COLUMNS} FROM flags
       WHERE project_id = $1 AND archived_at IS NULL ORDER BY key`,
      [projectId],
    );
    return rows.map(toStoredFlag);
  }

  async getFlag(projectId: string, key: string): Promise<StoredFlag | null> {
    const { rows } = await this.db.query<FlagRow>(
      `SELECT ${FLAG_COLUMNS} FROM flags WHERE project_id = $1 AND key = $2`,
      [projectId, key],
    );
    return rows[0] ? toStoredFlag(rows[0]) : null;
  }

  async insertFlag(projectId: string, flag: NewFlag): Promise<StoredFlag> {
    try {
      const { rows } = await this.db.query<FlagRow>(
        `INSERT INTO flags (project_id, key, name, description, enabled, variants,
           off_variant, rules, default_serve, salt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${FLAG_COLUMNS}`,
        [
          projectId,
          flag.key,
          flag.name,
          flag.description,
          flag.enabled,
          JSON.stringify(flag.variants),
          flag.offVariant,
          JSON.stringify(flag.rules),
          JSON.stringify(flag.defaultServe),
          flag.salt,
        ],
      );
      return toStoredFlag(rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictError('flag key already exists');
      throw error;
    }
  }

  async updateFlag(
    projectId: string,
    key: string,
    expectedVersion: number,
    changes: FlagChanges,
  ): Promise<StoredFlag | null> {
    const sets: string[] = [];
    const values: unknown[] = [projectId, key, expectedVersion];
    for (const [field, value] of Object.entries(changes)) {
      const target = CHANGE_COLUMNS[field as keyof FlagChanges];
      if (!target || value === undefined) continue;
      values.push(target.json ? JSON.stringify(value) : value);
      sets.push(`${target.column} = $${values.length}`);
    }
    // The optimistic-concurrency check is the `version = $3` condition: if
    // someone else saved first, no row matches and nothing is changed. The
    // ::bigint cast means a client-sent version too big for the integer column
    // simply doesn't match (→ 409) instead of failing the cast (→ 500).
    const { rows } = await this.db.query<FlagRow>(
      `UPDATE flags SET ${[...sets, 'version = version + 1', 'updated_at = now()'].join(', ')}
       WHERE project_id = $1 AND key = $2 AND version = $3::bigint AND archived_at IS NULL
       RETURNING ${FLAG_COLUMNS}`,
      values,
    );
    return rows[0] ? toStoredFlag(rows[0]) : null;
  }

  async archiveFlag(
    projectId: string,
    key: string,
    expectedVersion: number,
  ): Promise<StoredFlag | null> {
    const { rows } = await this.db.query<FlagRow>(
      `UPDATE flags SET archived_at = now(), version = version + 1, updated_at = now()
       WHERE project_id = $1 AND key = $2 AND version = $3::bigint AND archived_at IS NULL
       RETURNING ${FLAG_COLUMNS}`,
      [projectId, key, expectedVersion],
    );
    return rows[0] ? toStoredFlag(rows[0]) : null;
  }
}
