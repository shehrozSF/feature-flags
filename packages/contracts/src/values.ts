// Shared by both SDKs: a flag value is only used if it has the same JSON type as
// the caller's fallback; otherwise the SDK returns the fallback (reason ERROR).
import type { JsonValue } from '@ff/eval-core';

const kind = (v: JsonValue) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function sameJsonType(a: JsonValue, b: JsonValue): boolean {
  return kind(a) === kind(b);
}
