// Flag CRUD rules: validation, the 50-flag limit, archived keys staying
// reserved, and optimistic concurrency (ADR 0009). Every change bumps the
// project version in the same transaction, which is what SDKs watch.
import {
  FlagInputSchema,
  FlagPatchSchema,
  LIMITS,
  toFieldErrors,
  validateFlagShape,
  type FlagResource,
} from '@ff/contracts';
import { randomBase62 } from '../keys';
import { ConflictError, NotFoundError, PreconditionRequiredError, ValidationError } from './errors';
import type { Repository, StoredFlag } from './ports';

export function toResource(flag: StoredFlag): FlagResource {
  const { archivedAt, ...resource } = flag;
  return resource;
}

export class FlagService {
  constructor(private readonly repo: Repository) {}

  async list(projectId: string): Promise<FlagResource[]> {
    return (await this.repo.listFlags(projectId)).map(toResource);
  }

  async get(projectId: string, key: string): Promise<FlagResource> {
    return toResource(await this.active(projectId, key));
  }

  async create(projectId: string, input: unknown): Promise<FlagResource> {
    const parsed = FlagInputSchema.safeParse(input);
    if (!parsed.success) throw new ValidationError(toFieldErrors(parsed.error));
    const flag = parsed.data;

    if ((await this.repo.countActiveFlags(projectId)) >= LIMITS.flagsPerProject) {
      throw new ValidationError([
        { path: '', message: `project has reached the ${LIMITS.flagsPerProject}-flag limit` },
      ]);
    }
    const existing = await this.repo.getFlag(projectId, flag.key);
    if (existing?.archivedAt) throw new ConflictError('flag key is archived');

    return this.repo.withTransaction(async (tx) => {
      const stored = await tx.insertFlag(projectId, {
        ...flag,
        defaultServe: flag.defaultServe as StoredFlag['defaultServe'],
        rules: flag.rules as StoredFlag['rules'],
        salt: randomBase62(16),
      });
      await tx.bumpProjectVersion(projectId);
      return toResource(stored);
    });
  }

  async update(
    projectId: string,
    key: string,
    expectedVersion: number | null,
    patch: unknown,
  ): Promise<FlagResource> {
    if (expectedVersion === null) throw new PreconditionRequiredError();
    const parsed = FlagPatchSchema.safeParse(patch);
    if (!parsed.success) throw new ValidationError(toFieldErrors(parsed.error));
    const changes = parsed.data as Partial<StoredFlag>;

    const current = await this.active(projectId, key);
    const errors = validateFlagShape({ ...current, ...changes });
    if (errors.length > 0) throw new ValidationError(errors);

    return this.repo.withTransaction(async (tx) => {
      const updated = await tx.updateFlag(projectId, key, expectedVersion, changes);
      if (!updated) throw await this.conflictOrMissing(tx, projectId, key);
      await tx.bumpProjectVersion(projectId);
      return toResource(updated);
    });
  }

  async archive(projectId: string, key: string, expectedVersion: number | null): Promise<void> {
    if (expectedVersion === null) throw new PreconditionRequiredError();
    await this.active(projectId, key);
    await this.repo.withTransaction(async (tx) => {
      const archived = await tx.archiveFlag(projectId, key, expectedVersion);
      if (!archived) throw await this.conflictOrMissing(tx, projectId, key);
      await tx.bumpProjectVersion(projectId);
    });
  }

  private async active(projectId: string, key: string): Promise<StoredFlag> {
    const flag = await this.repo.getFlag(projectId, key);
    if (!flag || flag.archivedAt) throw new NotFoundError(`flag "${key}" not found`);
    return flag;
  }

  /** After a failed conditional write: someone else changed it (409), or it's gone (404). */
  private async conflictOrMissing(tx: Repository, projectId: string, key: string) {
    const now = await tx.getFlag(projectId, key);
    if (!now || now.archivedAt) return new NotFoundError(`flag "${key}" not found`);
    return new ConflictError('flag was changed by someone else', now);
  }
}
