import type { JsonValue } from '@ff/eval-core';
import type { BrowserClient, ClientStatus } from '@ff/sdk-client';
import { vi } from 'vitest';

/**
 * A BrowserClient whose flag values and status the test sets directly. The real
 * SDK has its own tests; here we only care how the shop reacts to it.
 */
export class FakeClient implements BrowserClient {
  values: Record<string, JsonValue> = {};
  private currentStatus: ClientStatus = 'live';
  private readonly change = new Set<() => void>();
  private readonly statusListeners = new Set<() => void>();
  identify = vi.fn(() => Promise.resolve());
  close = vi.fn();

  constructor(values: Record<string, JsonValue> = {}) {
    this.values = values;
  }

  ready() {
    return Promise.resolve();
  }

  variation<T extends JsonValue>(flagKey: string, fallback: T): T {
    return (Object.hasOwn(this.values, flagKey) ? this.values[flagKey] : fallback) as T;
  }

  variationDetail(flagKey: string, fallback: JsonValue) {
    return { variant: null, value: this.variation(flagKey, fallback), reason: 'DEFAULT' as const };
  }

  status() {
    return this.currentStatus;
  }

  on(event: 'change' | 'status', listener: () => void) {
    const set = event === 'status' ? this.statusListeners : this.change;
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Like a `changed` message arriving: new values, listeners told. */
  set(values: Record<string, JsonValue>) {
    this.values = { ...this.values, ...values };
    for (const l of [...this.change]) l();
  }

  setStatus(status: ClientStatus) {
    this.currentStatus = status;
    for (const l of [...this.statusListeners]) l();
  }
}
