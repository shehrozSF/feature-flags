import { LIMITS } from '@ff/contracts';
import type { Ruleset } from '@ff/eval-core';
import { describe, expect, it } from 'vitest';
import type { ProjectSnapshot } from '../src/domain/ports';
import { MemoryHub } from '../src/hub/memory-hub';

// A deleted project's hub must stay deleted. A reload that started before the
// deletion can still push its (now stale) snapshot afterwards; if the hub took it,
// the deleted project's keys would work again until the next refresh.
// The same rules run in the ProjectHub Durable Object (test-workers/project-hub.test.ts).
const HASH = 'c'.repeat(64);
const snap = (projectVersion: number): ProjectSnapshot => ({
  ruleset: { projectVersion, flags: {} } satisfies Ruleset,
  keys: [{ kind: 'client', hashHex: HASH }],
});

describe('MemoryHub evaluate limit (spec §9.2)', () => {
  // Counted in the hub's memory (never storage: no write per evaluate). A fixed
  // one-minute window per project; only client-key reads count.
  it('the 61st client read in a minute is limited, and the next minute starts fresh', async () => {
    let now = 0;
    const hub = new MemoryHub(() => now);
    await hub.update(snap(1));
    for (let i = 0; i < LIMITS.evaluatesPerMinute; i++) {
      expect((await hub.read('client', HASH)).status).toBe('ok');
    }
    now = 20_000;
    expect(await hub.read('client', HASH)).toEqual({ status: 'limited', retryAfterMs: 40_000 });
    now = 60_000;
    expect((await hub.read('client', HASH)).status).toBe('ok');
  });

  it('server reads (rules for server SDKs) are not limited', async () => {
    const hub = new MemoryHub(() => 0);
    await hub.update({ ...snap(1), keys: [{ kind: 'server', hashHex: HASH }] });
    for (let i = 0; i < LIMITS.evaluatesPerMinute + 5; i++) {
      expect((await hub.read('server', HASH)).status).toBe('ok');
    }
  });

  it('denied keys are not counted against the project', async () => {
    const hub = new MemoryHub(() => 0);
    await hub.update(snap(1));
    for (let i = 0; i < 100; i++) await hub.read('client', 'f'.repeat(64));
    expect((await hub.read('client', HASH)).status).toBe('ok');
  });
});

describe('MemoryHub after clear()', () => {
  it('a snapshot pushed after clear() is refused', async () => {
    const hub = new MemoryHub();
    await hub.update(snap(1));
    await hub.clear();
    expect(await hub.update(snap(2))).toEqual({ applied: false, version: 0 });
    expect(await hub.read('client', HASH)).toEqual({ status: 'denied' });
  });

  it('a cleared hub denies every key, without asking for a reload', async () => {
    const hub = new MemoryHub();
    await hub.update(snap(1));
    await hub.clear();
    // "cold" would make the Worker load the project from Postgres on every request.
    expect(await hub.read('client', HASH)).toEqual({ status: 'denied' });
    expect(await hub.read('server', 'd'.repeat(64))).toEqual({ status: 'denied' });
  });

  it('clear() on a cold hub still leaves the marker', async () => {
    const hub = new MemoryHub();
    await hub.clear();
    expect(await hub.update(snap(1))).toEqual({ applied: false, version: 0 });
    expect(await hub.read('client', HASH)).toEqual({ status: 'denied' });
  });
});
