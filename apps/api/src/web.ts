// The few web-standard globals the API needs, typed locally. The API's src
// loads no DOM, Node or Workers type libraries, so it can only use APIs that
// exist in all of them (same approach as eval-core's murmur3.ts).
type WebGlobals = {
  crypto: {
    getRandomValues<T extends Uint8Array>(array: T): T;
    subtle: { digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer> };
  };
  TextEncoder: new () => { encode(input: string): Uint8Array };
};

const web = globalThis as unknown as WebGlobals;

export const webCrypto = web.crypto;
export const textEncoder = new web.TextEncoder();
