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
