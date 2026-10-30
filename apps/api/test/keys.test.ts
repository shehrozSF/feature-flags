import { describe, expect, it } from 'vitest';
import { generateKey, hashSecret, parseKey } from '../src/keys';

const projectId = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('generateKey', () => {
  it('round-trips through parseKey', async () => {
    const { key, prefix } = await generateKey('admin', projectId);
    const parsed = parseKey(key);
    expect(parsed).toMatchObject({ kind: 'admin', projectId });
    expect(parsed!.secret).toMatch(/^[0-9A-Za-z]{43}$/);
    expect(prefix).toBe(`ff_admin_${projectId}_${parsed!.secret.slice(0, 4)}`);
  });

  it('stores the hash of the secret, not the secret', async () => {
    const { key, secretHash } = await generateKey('client', projectId);
    expect(toHex(secretHash)).toBe(toHex(await hashSecret(parseKey(key)!.secret)));
  });

  it('never repeats a secret', async () => {
    const a = await generateKey('server', projectId);
    const b = await generateKey('server', projectId);
    expect(a.key).not.toBe(b.key);
  });
});

describe('hashSecret', () => {
  it('is SHA-256', async () => {
    expect(toHex(await hashSecret('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('parseKey', () => {
  const secret = 'A'.repeat(43);

  it('parses a well-formed key', () => {
    expect(parseKey(`ff_client_${projectId}_${secret}`)).toEqual({
      kind: 'client',
      projectId,
      secret,
    });
  });

  // Anything malformed must come back as null (→ 401), never throw or reach
  // the database, where a non-UUID project id would be a 500.
  it.each([
    { name: 'undefined', raw: undefined },
    { name: 'empty', raw: '' },
    { name: 'unknown kind', raw: `ff_root_${projectId}_${secret}` },
    { name: 'project id not a UUID', raw: `ff_admin_not-a-uuid_${secret}` },
    { name: 'missing secret', raw: `ff_admin_${projectId}` },
    { name: 'extra part', raw: `ff_admin_${projectId}_${secret}_extra` },
    { name: 'wrong prefix', raw: `xx_admin_${projectId}_${secret}` },
    { name: 'secret with symbols', raw: `ff_admin_${projectId}_${'A'.repeat(42)}$` },
    { name: 'secret too short', raw: `ff_admin_${projectId}_abc` },
    { name: 'very long input', raw: 'ff_admin_'.padEnd(2000, 'x') },
  ])('rejects $name', ({ raw }) => {
    expect(parseKey(raw)).toBeNull();
  });
});
