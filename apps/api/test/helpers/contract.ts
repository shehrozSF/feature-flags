// Contract checking (ADR 0027): every response the tests see is matched to its
// route in the shared registry, its status must be one the route declares, and
// its body must parse with that status's schema. Covered route/status pairs
// are recorded so a final test can fail on any declared response never tested.
import { ROUTES, type RouteDef } from '@ff/contracts';
import { expect } from 'vitest';

const covered = new Set<string>();

const routePatterns = ROUTES.map((route) => ({
  route,
  regex: new RegExp(`^${route.path.replace(/\{[^}]+\}/g, '[^/]+')}$`),
}));

export function matchRoute(method: string, path: string): RouteDef | undefined {
  const pathname = new URL(path, 'http://x').pathname;
  return routePatterns.find(
    (p) => p.route.method === method.toUpperCase() && p.regex.test(pathname),
  )?.route;
}

export async function expectContract(route: RouteDef, res: Response): Promise<void> {
  const label = `${route.method} ${route.path} → ${res.status}`;
  expect(Object.keys(route.responses), `${label} is not a declared status`).toContain(
    String(res.status),
  );
  const schema = route.responses[res.status];
  const text = await res.clone().text();
  if (schema === null) {
    expect(text, `${label} should have no body`).toBe('');
  } else {
    const result = schema!.safeParse(JSON.parse(text));
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
      );
      expect.fail(`${label} broke the contract:\n  ${issues.join('\n  ')}`);
    }
  }
  covered.add(`${route.id} ${res.status}`);
}

/** Declared route/status pairs that no test has produced yet. */
export function uncoveredResponses(): string[] {
  return ROUTES.flatMap((route) =>
    Object.keys(route.responses)
      .map((status) => `${route.id} ${status}`)
      .filter((key) => !covered.has(key)),
  );
}
