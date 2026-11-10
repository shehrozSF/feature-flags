// Implementations of the SDK-side seams that read straight from Postgres.
// In Phase 3 the ProjectHub serves SDK reads; it is filled from PostgresSnapshotSource
// (ADR 0005, 0028).
import type { Ruleset } from '@ff/eval-core';
import { hashSecret, type ParsedKey } from '../keys';
import type {
  KeyVerifier,
  ProjectSnapshot,
  Repository,
  RulesetSource,
  SnapshotSource,
} from './ports';

export class PostgresSnapshotSource implements SnapshotSource {
  constructor(private readonly repo: Repository) {}

  load(projectId: string): Promise<ProjectSnapshot | null> {
    return this.repo.loadSnapshot(projectId);
  }
}

export class PostgresRulesetSource implements RulesetSource {
  constructor(private readonly repo: Repository) {}

  async getRuleset(projectId: string): Promise<Ruleset | null> {
    // Same consistent read as the hub gets, so both paths agree.
    return (await this.repo.loadSnapshot(projectId))?.ruleset ?? null;
  }
}

export class PostgresKeyVerifier implements KeyVerifier {
  constructor(private readonly repo: Repository) {}

  async verify(key: ParsedKey): Promise<boolean> {
    const stored = await this.repo.findKey(key.projectId, await hashSecret(key.secret));
    // The stored kind must match, so editing a key's prefix grants nothing (ADR 0017).
    return stored !== null && stored.kind === key.kind && stored.revokedAt === null;
  }
}
