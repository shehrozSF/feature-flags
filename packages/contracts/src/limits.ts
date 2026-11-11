export const LIMITS = {
  flagsPerProject: 50,
  variantsPerFlag: 10,
  rulesPerFlag: 20,
  conditionsPerRule: 10,
  rulesJsonBytes: 32768,
  /**
   * Per project: variants + rules + default serve of every active flag, as stored
   * (what SDKs download), so a snapshot stays small for Durable Object storage.
   */
  rulesetBytesPerProject: 1024 * 1024,
  contextKeys: 50,
  jsonDepth: 32,
  /** A sandbox is deleted this many days after its last dashboard use (ADR 0024). */
  /** Sandboxes one IP may create per hour (spec §9.2). */
  sandboxCreatesPerHour: 5,
  sandboxIdleDays: 30,
  /** At most this many live sandboxes; creating one more evicts the least recently used (ADR 0024). */
  sandboxes: 10_000,
} as const;

/**
 * True if a parsed JSON value nests deeper than maxDepth. Uses an explicit
 * stack instead of recursion, so a hostile 20,000-level document can't
 * overflow it - it must run before any recursive schema check does.
 */
export function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  const stack: [unknown, number][] = [[value, 1]];
  while (stack.length > 0) {
    const [current, depth] = stack.pop()!;
    if (typeof current !== 'object' || current === null) continue;
    if (depth > maxDepth) return true;
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}

export const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
