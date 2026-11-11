import { afterEach, describe, expect, it, vi } from 'vitest';
import { log, withRequestId } from '../src/log';

// Logs are one JSON object per line (spec §9.3), so Workers Logs can filter by
// field. What may appear in a line is decided by the logger, not by each caller.
const capture = () => {
  const lines: { method: string; line: Record<string, unknown> }[] = [];
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((text: string) => {
      lines.push({ method, line: JSON.parse(text) as Record<string, unknown> });
    });
  }
  return lines;
};
afterEach(() => vi.restoreAllMocks());

describe('log', () => {
  it('writes one JSON line with level and event', () => {
    const lines = capture();
    log('info', 'request', { route: '/v1/flags', status: 200 });
    expect(lines).toEqual([
      { method: 'log', line: { level: 'info', event: 'request', route: '/v1/flags', status: 200 } },
    ]);
  });

  it('warn and error use console.warn and console.error, so the platform sees the level', () => {
    const lines = capture();
    log('warn', 'a');
    log('error', 'b');
    expect(lines.map((l) => l.method)).toEqual(['warn', 'error']);
  });

  it('an error is logged by name, code and where it was thrown, never its message', () => {
    const lines = capture();
    const error = Object.assign(new Error('password=hunter2 user=canary@example.com'), {
      code: 'ECONNREFUSED',
      detail: 'Key (email)=(canary@example.com) already exists.',
    });
    log('error', 'failed', { error });

    const line = lines[0]!.line;
    expect(line).toMatchObject({ errorName: 'Error', errorCode: 'ECONNREFUSED' });
    expect(line.errorAt).toEqual(expect.stringContaining('log.test.ts'));
    const text = JSON.stringify(line);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('canary@example.com');
  });

  it("a message with line breaks can't sneak into the stack frames", () => {
    const lines = capture();
    log('error', 'failed', { error: new Error('first\n    at canary-frame (secret.ts:1:1)') });
    expect(JSON.stringify(lines[0]!.line)).not.toContain('canary');
  });

  it('something thrown that is not an Error is logged by type only', () => {
    const lines = capture();
    log('error', 'failed', { error: 'canary string' });
    expect(lines[0]!.line).toEqual({ level: 'error', event: 'failed', errorName: 'string' });
  });

  it('fields outside the allow-list are dropped', () => {
    const lines = capture();
    const sneaky = { route: '/x', context: { userId: 'canary' }, key: 'ff_admin_x' };
    log('info', 'request', sneaky); // extra properties pass the type check on a variable
    expect(lines[0]!.line).toEqual({ level: 'info', event: 'request', route: '/x' });
  });

  it('lines inside a request carry its request id, also after an await', async () => {
    const lines = capture();
    await withRequestId('req-1', async () => {
      log('info', 'before');
      await new Promise((resolve) => setTimeout(resolve, 1));
      log('info', 'after');
    });
    log('info', 'outside');
    expect(lines.map((l) => l.line.requestId)).toEqual(['req-1', 'req-1', undefined]);
  });
});
