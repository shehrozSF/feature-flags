// The few web-standard globals the API needs, typed locally. The API's src
// loads no DOM, Node or Workers type libraries, so it can only use APIs that
// exist in all of them (same approach as eval-core's murmur3.ts).
type HmacKey = { readonly type: 'secret' };
type HmacAlgorithm = { name: 'HMAC'; hash: 'SHA-256' };

type WebGlobals = {
  crypto: {
    getRandomValues<T extends Uint8Array>(array: T): T;
    subtle: {
      digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
      importKey(
        format: 'raw',
        keyData: Uint8Array,
        algorithm: HmacAlgorithm,
        extractable: false,
        usages: ('sign' | 'verify')[],
      ): Promise<HmacKey>;
      sign(algorithm: 'HMAC', key: HmacKey, data: Uint8Array): Promise<ArrayBuffer>;
      /** Compares in constant time, so a signature can't be guessed byte by byte. */
      verify(
        algorithm: 'HMAC',
        key: HmacKey,
        signature: Uint8Array,
        data: Uint8Array,
      ): Promise<boolean>;
    };
  };
  TextEncoder: new () => { encode(input: string): Uint8Array };
  TextDecoder: new (
    label?: 'utf-8',
    options?: { fatal: boolean },
  ) => { decode(input: Uint8Array): string };
  btoa(data: string): string;
  atob(data: string): string;
};

const web = globalThis as unknown as WebGlobals;

export const webCrypto = web.crypto;
export const textEncoder = new web.TextEncoder();
/** Throws on invalid UTF-8 instead of inserting replacement characters. */
export const textDecoder = new web.TextDecoder('utf-8', { fatal: true });

/** Bytes to base64url without padding (RFC 4648 §5): safe in URLs, JSON and headers. */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return web.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The reverse of toBase64Url; null for anything that isn't base64url. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const binary = web.atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
