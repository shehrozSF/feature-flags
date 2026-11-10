// The WebSocket protocol of spec §6.3, shared by both SDKs: what the server sends,
// how often clients keep the socket alive, and how they back off after a drop.
import { z } from 'zod';

export const StreamMessageSchema = z.object({
  type: z.enum(['hello', 'changed']),
  version: z.number().int().nonnegative(),
});
export type StreamMessage = z.infer<typeof StreamMessageSchema>;

/** A server message, or null for anything else (`pong`, garbage, unknown shapes). */
export function parseStreamMessage(text: string): StreamMessage | null {
  try {
    const result = StreamMessageSchema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Clients send the text `ping` this often; the hub answers `pong` without waking up. */
export const KEEPALIVE_MS = 30_000;

/** Reconnect waits: 1 s doubling up to 30 s (spec §8.1). */
export const BACKOFF = { baseMs: 1_000, capMs: 30_000 } as const;

/**
 * Full jitter: a random wait between 0 and min(cap, base · 2^attempt), so clients
 * that lost the same server don't all reconnect at the same moment. `attempt`
 * counts failed tries since the last good connection, starting at 0.
 */
export function backoffDelay(
  attempt: number,
  random: () => number,
  base: number = BACKOFF.baseMs,
  cap: number = BACKOFF.capMs,
): number {
  return Math.floor(random() * Math.min(cap, base * 2 ** attempt));
}
