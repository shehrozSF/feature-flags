// API keys: ff_<kind>_<projectId>_<secret> (ADR 0017). Only the SHA-256 of the
// secret is stored. The kind and project id are readable without any I/O, so a
// request can be routed or rejected before touching the database.
import { textEncoder, webCrypto } from './web';

export type KeyKind = 'admin' | 'server' | 'client';
export type ParsedKey = { kind: KeyKind; projectId: string; secret: string };

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SECRET_LENGTH = 43; // ≈ 256 bits of randomness
const KEY_PATTERN =
  /^ff_(admin|server|client)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9A-Za-z]{43})$/;

/** Random base62 string. Bytes ≥ 248 are skipped so every character is equally likely. */
export function randomBase62(length: number): string {
  let out = '';
  while (out.length < length) {
    for (const byte of webCrypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < 248 && out.length < length) out += BASE62[byte % 62];
    }
  }
  return out;
}

export async function hashSecret(secret: string): Promise<Uint8Array> {
  return new Uint8Array(await webCrypto.subtle.digest('SHA-256', textEncoder.encode(secret)));
}

export async function generateKey(
  kind: KeyKind,
  projectId: string,
): Promise<{ key: string; secretHash: Uint8Array; prefix: string }> {
  const secret = randomBase62(SECRET_LENGTH);
  return {
    key: `ff_${kind}_${projectId}_${secret}`,
    secretHash: await hashSecret(secret),
    prefix: `ff_${kind}_${projectId}_${secret.slice(0, 4)}`,
  };
}

/** Parses a key; anything malformed returns null so callers answer 401, never 500. */
export function parseKey(raw: string | undefined | null): ParsedKey | null {
  if (!raw || raw.length > 200) return null;
  const match = KEY_PATTERN.exec(raw);
  if (!match) return null;
  return { kind: match[1] as KeyKind, projectId: match[2]!, secret: match[3]! };
}
