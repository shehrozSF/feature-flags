// The interfaces the domain depends on. Postgres implements them now; the
// ProjectHub Durable Object implements RulesetSource/KeyVerifier in Phase 3.
import type { FlagResource } from '@ff/contracts';
import type { Flag, Ruleset } from '@ff/eval-core';
import type { KeyKind, ParsedKey } from '../keys';

/** Where SDK/client routes get rules from. Null means the project doesn't exist. */
export interface RulesetSource {
  getRuleset(projectId: string): Promise<Ruleset | null>;
}

/** True only if the key exists for that project, has the claimed kind, and isn't revoked. */
export interface KeyVerifier {
  verify(key: ParsedKey): Promise<boolean>;
}

/** Everything the ProjectHub needs to answer SDK reads, taken at one moment. */
export type ProjectSnapshot = {
  /** projectVersion + non-archived flags. */
  ruleset: Ruleset;
  /** Active (non-revoked) keys only; hashHex is the lowercase hex SHA-256 of the secret. */
  keys: { kind: KeyKind; hashHex: string }[];
};

/** Loads project snapshots for the hub. Null means the project doesn't exist. */
export interface SnapshotSource {
  load(projectId: string): Promise<ProjectSnapshot | null>;
}

export type StoredFlag = FlagResource & { archivedAt: string | null };
export type NewFlag = Omit<Flag, 'version'> & { name: string; description: string };
export type FlagChanges = Partial<Omit<NewFlag, 'key' | 'salt'>>;
export type StoredKey = { kind: KeyKind; revokedAt: string | null };
/** A project's webhook as shown to its owner: never the secret (ADR 0039). */
export type WebhookInfo = { url: string; createdAt: string; updatedAt: string };
/** As stored: the dispatcher needs the secret to sign events. */
export type StoredWebhook = WebhookInfo & { secret: string };

export interface Repository {
  withTransaction<T>(fn: (tx: Repository) => Promise<T>): Promise<T>;
  createProject(input: { name: string; expiresAt: Date | null }): Promise<{ id: string }>;
  insertKey(
    projectId: string,
    key: { kind: KeyKind; secretHash: Uint8Array; prefix: string },
  ): Promise<void>;
  findKey(projectId: string, secretHash: Uint8Array): Promise<StoredKey | null>;
  /** Inside a transaction: blocks other transactions that lock the same project until commit. */
  lockProject(projectId: string): Promise<void>;
  projectVersion(projectId: string): Promise<number | null>;
  bumpProjectVersion(projectId: string): Promise<number>;
  countActiveFlags(projectId: string): Promise<number>;
  /** Bytes of variants + rules + default serve over the project's active flags, as stored. */
  rulesetBytes(projectId: string): Promise<number>;
  /**
   * Marks a sandbox as used now: expires_at moves to now + idleDays. Writes at most
   * once an hour per project (older activity only), and never touches owned projects.
   */
  touchActivity(projectId: string, idleDays: number): Promise<void>;
  /**
   * Inside a transaction: makes sandbox creations wait for each other until commit,
   * so counting and evicting can't race (the cap would be exceeded otherwise).
   */
  lockSandboxCreation(): Promise<void>;
  /** Live sandboxes (projects with no owner). */
  countSandboxes(): Promise<number>;
  /** Deletes the sandbox with the oldest last_active_at; returns its id, or null if none. */
  evictOldestSandbox(): Promise<string | null>;
  /** Deletes up to `limit` expired projects, longest expired first; returns their ids. */
  deleteExpired(limit: number): Promise<string[]>;
  /** Creates or replaces the project's webhook; createdAt survives a replace. */
  setWebhook(projectId: string, url: string, secret: string): Promise<WebhookInfo>;
  getWebhook(projectId: string): Promise<StoredWebhook | null>;
  /** True if there was one to delete. */
  deleteWebhook(projectId: string): Promise<boolean>;
  /** Version, flags and active keys from one consistent read. Null for an unknown project. */
  loadSnapshot(projectId: string): Promise<ProjectSnapshot | null>;
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
