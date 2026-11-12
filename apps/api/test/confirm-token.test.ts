import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONFIRM_TTL_MS,
  signConfirmToken,
  verifyConfirmToken,
  type PendingChange,
} from '../src/mcp/confirm-token';
import { fromBase64Url, toBase64Url } from '../src/web';

const SECRET = 'test-secret-that-is-long-enough-0123456789';
const OTHER_SECRET = 'another-secret-that-is-long-enough-987654';
const PROJECT = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const OTHER_PROJECT = '9e8d7c6b-5a49-4382-a1b0-c9d8e7f6a5b4';
const NOW = Date.parse('2026-11-12T10:00:00Z');

const update: PendingChange = {
  projectId: PROJECT,
  key: 'checkout-v2',
  baseVersion: 7,
  op: 'update',
  body: {
    defaultServe: {
      rollout: [
        { variant: 'on', weight: 2500 },
        { variant: 'off', weight: 7500 },
      ],
    },
  },
};
const archive: PendingChange = { projectId: PROJECT, key: 'old', baseVersion: 3, op: 'archive' };

const verify = (
  token: string,
  overrides: { secret?: string; projectId?: string; now?: number } = {},
) =>
  verifyConfirmToken(token, overrides.secret ?? SECRET, {
    projectId: overrides.projectId ?? PROJECT,
    now: overrides.now ?? NOW,
  });

/** Decoded payload of a token, to build tampered copies. */
const payloadOf = (token: string) =>
  JSON.parse(Buffer.from(fromBase64Url(token.split('.')[1]!)!).toString()) as Record<
    string,
    unknown
  >;

/** Same signature, new payload: what someone editing the token by hand would produce. */
const withPayload = (token: string, payload: unknown) => {
  const [version, , signature] = token.split('.');
  return `${version}.${toBase64Url(Buffer.from(JSON.stringify(payload)))}.${signature}`;
};

describe('confirm token: the round trip', () => {
  it.each([
    ['an update', update],
    ['an archive', archive],
  ])('%s comes back exactly as signed', async (_, change) => {
    const { token } = await signConfirmToken(change, SECRET, NOW);
    expect(await verify(token)).toEqual({ ok: true, change });
  });

  it('expires 5 minutes after signing, and says when', async () => {
    const { expiresAt } = await signConfirmToken(update, SECRET, NOW);
    expect(expiresAt).toBe('2026-11-12T10:05:00.000Z');
  });

  it('is URL- and header-safe text: v1.<payload>.<signature>', async () => {
    const { token } = await signConfirmToken(update, SECRET, NOW);
    expect(token).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('the signature is plain HMAC-SHA256 of "v1.<payload>" (checked with Node crypto)', async () => {
    // Pins the format independently of our own code: a receiver in another
    // language could verify it with any HMAC library.
    const { token } = await signConfirmToken(update, SECRET, NOW);
    const [version, payload, signature] = token.split('.');
    const expected = createHmac('sha256', SECRET)
      .update(`${version}.${payload}`)
      .digest('base64url');
    expect(signature).toBe(expected);
  });

  it('round-trips any update body (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), fc.nat(), async (body, baseVersion) => {
        // JSON drops -0's sign; compare what JSON can carry.
        const change = {
          ...update,
          baseVersion,
          body: JSON.parse(JSON.stringify(body)) as unknown,
        };
        const { token } = await signConfirmToken(change, SECRET, NOW);
        expect(await verify(token)).toEqual({ ok: true, change });
      }),
      { numRuns: 50 },
    );
  });
});

describe('confirm token: expiry', () => {
  it('still valid at the last millisecond', async () => {
    const { token } = await signConfirmToken(update, SECRET, NOW);
    expect((await verify(token, { now: NOW + CONFIRM_TTL_MS })).ok).toBe(true);
  });

  it('expired one millisecond later', async () => {
    const { token } = await signConfirmToken(update, SECRET, NOW);
    expect(await verify(token, { now: NOW + CONFIRM_TTL_MS + 1 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('confirm token: rejected', () => {
  it('another project: a token is useless with any other admin key', async () => {
    const { token } = await signConfirmToken(update, SECRET, NOW);
    expect(await verify(token, { projectId: OTHER_PROJECT })).toEqual({
      ok: false,
      reason: 'wrong-project',
    });
  });

  it('another secret: tokens die when the secret is rotated', async () => {
    const { token } = await signConfirmToken(update, SECRET, NOW);
    expect(await verify(token, { secret: OTHER_SECRET })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  // Each edit a model (or a person) might try. All fail on the signature,
  // which is checked before anything in the payload is believed.
  it.each([
    ['a different body', { body: { enabled: false } }],
    ['another flag', { key: 'other-flag' }],
    ['archive instead of the update', { op: 'archive' }],
    ['a later expiry', { exp: NOW + 24 * 60 * 60 * 1000 }],
    ['another project', { projectId: OTHER_PROJECT }],
    ['a newer base version', { baseVersion: 99 }],
  ])('an edited payload (%s) is a bad signature', async (_, edit) => {
    const { token } = await signConfirmToken(update, SECRET, NOW);
    const tampered = withPayload(token, { ...payloadOf(token), ...edit });
    // For "another project", check as that project: the signature must stop it,
    // not the project comparison.
    const projectId = 'projectId' in edit ? OTHER_PROJECT : PROJECT;
    expect(await verify(tampered, { projectId })).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('a signature flipped by one character is a bad signature', async () => {
    const { token } = await signConfirmToken(update, SECRET, NOW);
    const last = token.at(-2) === 'A' ? 'B' : 'A'; // not the final char: its low bits are padding
    const flipped = `${token.slice(0, -2)}${last}${token.at(-1)}`;
    expect(await verify(flipped)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it.each([
    ['empty', ''],
    ['one part', 'v1'],
    ['two parts', 'v1.abc'],
    ['four parts', 'v1.a.b.c'],
    ['another version', 'v2.abc.def'],
    ['not base64url', 'v1.ab+c.def'],
    ['impossible base64 length', 'v1.abcde.def'],
  ])('%s is malformed', async (_, token) => {
    expect(await verify(token)).toEqual({ ok: false, reason: 'malformed' });
  });

  it("a validly signed payload that isn't JSON is malformed, not a crash", async () => {
    // Only reachable with the real secret, e.g. a future token format.
    const payload = toBase64Url(Buffer.from('not json'));
    const signature = createHmac('sha256', SECRET).update(`v1.${payload}`).digest('base64url');
    expect(await verify(`v1.${payload}.${signature}`)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('confirm token: the secret', () => {
  it('refuses a short secret instead of signing with it', async () => {
    await expect(signConfirmToken(update, 'too-short', NOW)).rejects.toThrow(
      'MCP_CONFIRM_SECRET must be at least 32 characters',
    );
  });
});

describe('base64url helpers', () => {
  it('round-trip any bytes (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        const text = toBase64Url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect(fromBase64Url(text)).toEqual(bytes);
      }),
    );
  });

  it("match Node's own base64url", () => {
    const bytes = Uint8Array.from([251, 255, 191, 0, 1, 62, 63]);
    expect(toBase64Url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
  });
});
