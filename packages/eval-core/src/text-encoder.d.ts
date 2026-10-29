// eval-core loads no DOM or Node type libraries, so it can't accidentally use
// runtime-specific APIs. TextEncoder is the one exception: it exists in Node,
// Workers and browsers alike.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
