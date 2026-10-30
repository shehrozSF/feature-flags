// The interfaces the domain depends on. Postgres implements them now; the
// ProjectHub Durable Object implements RulesetSource/KeyVerifier in Phase 3.
import type { FlagResource } from '@ff/contracts';
import type { Flag } from '@ff/eval-core';
import type { KeyKind } from '../keys';

export type StoredFlag = FlagResource & { archivedAt: string | null };
export type NewFlag = Omit<Flag, 'version'> & { name: string; description: string };
export type FlagChanges = Partial<Omit<NewFlag, 'key' | 'salt'>>;
export type StoredKey = { kind: KeyKind; revokedAt: string | null };

export interface Repository {
  withTransaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>;
  createProject(input: { name: string; expiresAt: Date | null }): Promise<{ id: string }>;
  insertKey(
    projectId: string,
    key: { kind: KeyKind; secretHash: Uint8Array; prefix: string },
  ): Promise<void>;
  findKey(projectId: string, secretHash: Uint8Array): Promise<StoredKey | null>;
  projectVersion(projectId: string): Promise<number | null>;
  bumpProjectVersion(projectId: string): Promise<number>;
  countActiveFlags(projectId: string): Promise<number>;
  /** Non-archived flags, ordered by key. */
  listFlags(projectId: string): Promise<StoredFlag[]>;
  /** Includes archived flags. */
  getFlag(projectId: string, key: string): Promise<StoredFlag | null>;
  /** Throws ConflictError if the key exists (archived or not). */
  insertFlag(projectId: string, flag: NewFlag): Promise<StoredFlag>;
  /** Null when the flag is missing, archived, or not at expectedVersion. */
  updateFlag(
    projectId: string,
    key: string,
    expectedVersion: number,
    changes: FlagChanges,
  ): Promise<StoredFlag | null>;
  archiveFlag(projectId: string, key: string, expectedVersion: number): Promise<StoredFlag | null>;
}
