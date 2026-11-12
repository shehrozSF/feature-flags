// The confirm token behind MCP writes (ADR 0038). propose_flag_change signs the
// exact change it previewed; apply_flag_change performs only what a valid token
// says. Stateless: nothing is stored. A replayed or stale token is stopped by the
// flag version it carries (sent as If-Match), not by a list of used tokens.
//
// Format: "v1.<base64url JSON payload>.<base64url HMAC-SHA256 of 'v1.<payload>'>".
import { fromBase64Url, textDecoder, textEncoder, toBase64Url, webCrypto } from '../web';

/** What apply_flag_change will do: a PATCH with `body`, or an archive (DELETE). */
export type PendingChange =
  | { projectId: string; key: string; baseVersion: number; op: 'update'; body: unknown }
  | { projectId: string; key: string; baseVersion: number; op: 'archive' };

type Payload = PendingChange & { exp: number };

export type VerifyResult =
  | { ok: true; change: PendingChange }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' | 'wrong-project' };

const VERSION = 'v1';
export const CONFIRM_TTL_MS = 5 * 60 * 1000;
/** 32 characters: anything shorter is a placeholder, not a secret. */
export const MIN_SECRET_LENGTH = 32;

async function hmacKey(secret: string) {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`MCP_CONFIRM_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return webCrypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signConfirmToken(
  change: PendingChange,
  secret: string,
  now = Date.now(),
): Promise<{ token: string; expiresAt: string }> {
  const exp = now + CONFIRM_TTL_MS;
  const payload: Payload = { ...change, exp };
  const signed = `${VERSION}.${toBase64Url(textEncoder.encode(JSON.stringify(payload)))}`;
  const signature = await webCrypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    textEncoder.encode(signed),
  );
  return {
    token: `${signed}.${toBase64Url(new Uint8Array(signature))}`,
    expiresAt: new Date(exp).toISOString(),
  };
}

/**
 * Checks, in this order: shape, signature, project, expiry. The signature comes
 * before anything read from the payload, so an edited payload (a later `exp`,
 * another project, another body) is always "bad-signature".
 */
export async function verifyConfirmToken(
  token: string,
  secret: string,
  expected: { projectId: string; now?: number },
): Promise<VerifyResult> {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, encodedPayload, encodedSignature] = parts as [string, string, string];
  const payloadBytes = fromBase64Url(encodedPayload);
  const signature = fromBase64Url(encodedSignature);
  if (!payloadBytes || !signature) return { ok: false, reason: 'malformed' };

  const valid = await webCrypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    textEncoder.encode(`${VERSION}.${encodedPayload}`),
  );
  if (!valid) return { ok: false, reason: 'bad-signature' };

  // Signed by us, so the shape is ours; parsing can only fail for a token from a
  // future format sharing this secret, which counts as malformed.
  let payload: Payload;
  try {
    payload = JSON.parse(textDecoder.decode(payloadBytes)) as Payload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.projectId !== expected.projectId) return { ok: false, reason: 'wrong-project' };
  if ((expected.now ?? Date.now()) > payload.exp) return { ok: false, reason: 'expired' };

  const { exp: _exp, ...change } = payload;
  return { ok: true, change };
}
