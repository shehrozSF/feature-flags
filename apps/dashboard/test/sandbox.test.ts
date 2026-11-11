import { beforeEach, describe, expect, it } from 'vitest';
import { demoLink, loadSandbox, saveSandbox } from '../src/sandbox';
import { KEYS } from './fixtures';

// The sandbox's keys live in localStorage (ADR 0021), so a reload keeps the sandbox.
const SANDBOX = { projectId: '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f', keys: KEYS };
beforeEach(() => localStorage.clear());

describe('sandbox storage', () => {
  it('the sandbox survives a reload', () => {
    saveSandbox(localStorage, SANDBOX);
    expect(loadSandbox(localStorage)).toEqual(SANDBOX);
  });

  it('nothing saved, or something broken, means no sandbox', () => {
    expect(loadSandbox(localStorage)).toBeNull();
    localStorage.setItem('ff:dashboard:sandbox', '{"projectId":1}');
    expect(loadSandbox(localStorage)).toBeNull();
  });

  it('storage that throws means no saved sandbox, not a crash', () => {
    const blocked = new Proxy({} as Storage, {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(() => saveSandbox(blocked, SANDBOX)).not.toThrow();
    expect(loadSandbox(blocked)).toBeNull();
  });
});

describe('demo link', () => {
  it('the demo link carries both keys in the fragment, URL-encoded', () => {
    const link = demoLink('https://shehrozsf.github.io/feature-flags/demo/', KEYS);
    const url = new URL(link);
    expect(url.search).toBe(''); // never in the query: that reaches servers and logs
    const fragment = new URLSearchParams(url.hash.slice(1));
    expect(fragment.get('client')).toBe(KEYS.client);
    expect(fragment.get('server')).toBe(KEYS.server);
    expect(link).not.toContain(KEYS.admin); // the admin key never leaves the dashboard
  });
});
