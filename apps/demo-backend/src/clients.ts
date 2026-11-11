// One server SDK client per sandbox server key, kept for the isolate's life, with
// a size limit: every visitor has their own sandbox, so an unbounded map would
// grow without end. The least recently used client is closed and dropped.
import { createServerClient, type ServerClient } from '@ff/sdk-server';

export function createClientCache(options: { apiUrl: string; fetch: typeof fetch; max: number }) {
  // Promises, so two requests for a new key at once share one client.
  const clients = new Map<string, Promise<ServerClient>>();

  return function getClient(serverKey: string): Promise<ServerClient> {
    const existing = clients.get(serverKey);
    if (existing) {
      // Most recently used goes to the end.
      clients.delete(serverKey);
      clients.set(serverKey, existing);
      return existing;
    }
    const created = createServerClient({
      serverKey,
      baseUrl: options.apiUrl,
      mode: 'polling', // Workers: no long-lived sockets (spec §8.1)
      cacheTtlMs: 1000, // short, so the demo's price follows a flag flip within a second or two
      fetch: options.fetch,
      // One JSON line, like the API's logs (spec §9.3). The SDK's messages are its
      // own status text ("GET /v1/sdk/rules answered 401"): never keys or contexts.
      logger: {
        warn: (message) =>
          console.warn(JSON.stringify({ level: 'warn', event: 'sdk warning', message })),
      },
    });
    clients.set(serverKey, created);
    while (clients.size > options.max) {
      const [oldestKey, oldest] = clients.entries().next().value!;
      clients.delete(oldestKey);
      void oldest.then((client) => client.close());
    }
    return created;
  };
}
