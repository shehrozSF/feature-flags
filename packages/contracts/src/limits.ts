export const LIMITS = {
  flagsPerProject: 50,
  variantsPerFlag: 10,
  rulesPerFlag: 20,
  conditionsPerRule: 10,
  rulesJsonBytes: 32768,
  contextKeys: 50,
  jsonDepth: 32,
} as const;

/**
 * True if a parsed JSON value nests deeper than maxDepth. Uses an explicit
 * stack instead of recursion, so a hostile 20,000-level document can't
 * overflow it — it must run before any recursive schema check does.
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
