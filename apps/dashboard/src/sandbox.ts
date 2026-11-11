// The visitor's sandbox: its id and three keys, kept in localStorage so a reload
// keeps the same sandbox (ADR 0021, an accepted risk for anonymous sandboxes).
import { SandboxResponseSchema } from '@ff/contracts';
import type { Keys, Sandbox } from './api';

const STORAGE_KEY = 'ff:dashboard:sandbox';

export function loadSandbox(storage: Storage | null): Sandbox | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = SandboxResponseSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // blocked storage or a broken entry: start fresh
  }
}

export function saveSandbox(storage: Storage | null, sandbox: Sandbox): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sandbox));
  } catch {
    // No storage: the sandbox works until the tab closes.
  }
}

export function forgetSandbox(storage: Storage | null): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more we can do.
  }
}

/**
 * The demo site's address for this sandbox. The keys go in the #fragment: browsers
 * never send it to servers, so it stays out of request logs (ADR 0030). The admin
 * key never leaves the dashboard.
 */
export function demoLink(demoBaseUrl: string, keys: Keys): string {
  const fragment = new URLSearchParams({ client: keys.client, server: keys.server });
  return `${demoBaseUrl}#${fragment.toString()}`;
}
