// Phase 2 implementations of the SDK-side seams, reading straight from
// Postgres. Phase 3 replaces them with the ProjectHub cache (ADR 0005, 0028).
import type { Flag, Ruleset } from '@ff/eval-core';
import { hashSecret, type ParsedKey } from '../keys';
import type { KeyVerifier, Repository, RulesetSource } from './ports';

export class PostgresRulesetSource implements RulesetSource {
  constructor(private readonly repo: Repository) {}

  async getRuleset(projectId: string): Promise<Ruleset | null> {
    // One transaction, so the version and the flags come from the same moment.
    return this.repo.withTransaction(async (tx) => {
      const projectVersion = await tx.projectVersion(projectId);
      if (projectVersion === null) return null;
      const flags: Record<string, Flag> = {};
      for (const f of await tx.listFlags(projectId)) {
        flags[f.key] = {
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
      return { projectVersion, flags };
    });
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
