// The only place SQL lives (ADR 0012). Rows are mapped to domain objects in
// one function, and the optimistic-concurrency check is a single UPDATE.
import type pg from 'pg';
import { ConflictError } from '../domain/errors';
import type { FlagChanges, NewFlag, Repository, StoredFlag, StoredKey } from '../domain/ports';
import type { KeyKind } from '../keys';

type Queryable = pg.Pool | pg.PoolClient;

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

export class PostgresRepository implements Repository {
  constructor(
    private readonly db: Queryable,
    private readonly inTransaction = false,
  ) {}

  async withTransaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    const client = await (this.db as pg.Pool).connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PostgresRepository(client, true));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
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
    // someone else saved first, no row matches and nothing is changed.
    const { rows } = await this.db.query<FlagRow>(
      `UPDATE flags SET ${[...sets, 'version = version + 1', 'updated_at = now()'].join(', ')}
       WHERE project_id = $1 AND key = $2 AND version = $3 AND archived_at IS NULL
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
       WHERE project_id = $1 AND key = $2 AND version = $3 AND archived_at IS NULL
       RETURNING ${FLAG_COLUMNS}`,
      [projectId, key, expectedVersion],
    );
    return rows[0] ? toStoredFlag(rows[0]) : null;
  }
}
