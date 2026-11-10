import { describe, expect, it } from 'vitest';
import { backoffDelay, BACKOFF, KEEPALIVE_MS, parseStreamMessage } from '../src/index';

// The WebSocket protocol of spec §6.3, shared by the API's hub and both SDKs.
describe('stream messages', () => {
  it('parses hello and changed', () => {
    expect(parseStreamMessage('{"type":"hello","version":0}')).toEqual({
      type: 'hello',
      version: 0,
    });
    expect(parseStreamMessage('{"type":"changed","version":43}')).toEqual({
      type: 'changed',
      version: 43,
    });
  });

  it('rejects pong, garbage, negative or fractional versions, extra types', () => {
    for (const text of [
      'pong',
      '',
      'not json',
      'null',
      '[]',
      '{"type":"hello"}',
      '{"type":"hello","version":-1}',
      '{"type":"hello","version":1.5}',
      '{"type":"hello","version":"1"}',
      '{"type":"rules","version":1}',
    ]) {
      expect(parseStreamMessage(text), text).toBeNull();
    }
  });

  it('keeps alive every 30 seconds', () => {
    expect(KEEPALIVE_MS).toBe(30_000);
  });
});

describe('reconnect backoff', () => {
  it('backoff grows then caps', () => {
    const almostOne = () => 0.999999;
    const delays = [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, almostOne));
    expect(delays).toEqual([999, 1999, 3999, 7999, 15999, 29999, 29999]);
    expect(BACKOFF).toEqual({ baseMs: 1_000, capMs: 30_000 });
  });

  it('backoff is jittered', () => {
    // Full jitter: anywhere from 0 to the current ceiling, so clients that lost
    // the same server don't all come back at the same moment.
    expect(backoffDelay(5, () => 0)).toBe(0);
    expect(backoffDelay(3, () => 0.5)).toBe(4000);
  });

  it('takes a custom base and cap', () => {
    expect(backoffDelay(10, () => 0.999999, 50, 400)).toBe(399);
  });
});
