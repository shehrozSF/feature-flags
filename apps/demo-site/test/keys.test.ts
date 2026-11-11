import { beforeEach, describe, expect, it, vi } from 'vitest';
import { takeKeysFromUrl } from '../src/keys';

// The dashboard opens the demo with the sandbox's keys in the URL fragment
// (#client=…&server=…). The demo keeps them and cleans the address bar (ADR 0030).
const ID = '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f';
const KEYS = {
  client: `ff_client_${ID}_${'C'.repeat(43)}`,
  server: `ff_server_${ID}_${'S'.repeat(43)}`,
};
const fragment = (params: Record<string, string>) => `#${new URLSearchParams(params).toString()}`;

function fakeLocation(hash: string) {
  const location = { hash, pathname: '/feature-flags/demo/', search: '' } as Location;
  const replaceState = vi.fn();
  const history = { replaceState } as unknown as History;
  return { location, history, replaceState };
}

beforeEach(() => localStorage.clear());

describe('keys from the dashboard link', () => {
  it('keys move from the fragment into storage and the fragment is removed', () => {
    const { location, history, replaceState } = fakeLocation(fragment(KEYS));
    expect(takeKeysFromUrl(location, history, localStorage)).toEqual(KEYS);
    expect(JSON.parse(localStorage.getItem('ff:demo:keys')!)).toEqual(KEYS);
    // The address bar no longer shows the keys (so they aren't copied or bookmarked).
    expect(replaceState).toHaveBeenCalledWith(null, '', '/feature-flags/demo/');
  });

  it('keys already in storage are used when the URL has none', () => {
    localStorage.setItem('ff:demo:keys', JSON.stringify(KEYS));
    const { location, history, replaceState } = fakeLocation('');
    expect(takeKeysFromUrl(location, history, localStorage)).toEqual(KEYS);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('a malformed fragment is ignored', () => {
    for (const hash of [
      fragment({ client: 'nope', server: KEYS.server }),
      fragment({ client: KEYS.server, server: KEYS.client }), // swapped kinds
      fragment({ client: KEYS.client }), // server missing
      '#garbage',
    ]) {
      const { location, history } = fakeLocation(hash);
      expect(takeKeysFromUrl(location, history, localStorage), hash).toBeNull();
    }
    expect(localStorage.getItem('ff:demo:keys')).toBeNull();
  });

  it('new keys in the URL replace older stored ones', () => {
    localStorage.setItem(
      'ff:demo:keys',
      JSON.stringify({ client: `ff_client_${ID}_${'X'.repeat(43)}`, server: KEYS.server }),
    );
    const { location, history } = fakeLocation(fragment(KEYS));
    expect(takeKeysFromUrl(location, history, localStorage)).toEqual(KEYS);
  });

  it('works when storage throws (keys still used for this visit)', () => {
    const blocked = new Proxy({} as Storage, {
      get() {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    const { location, history } = fakeLocation(fragment(KEYS));
    expect(takeKeysFromUrl(location, history, blocked)).toEqual(KEYS);
  });
});
