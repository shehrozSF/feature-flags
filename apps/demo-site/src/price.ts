// The demo shop's price comes from demo-backend (spec §9.4), which evaluates
// `new-pricing` with the server SDK. The browser forwards its sandbox's server
// key in a header (ADR 0030) and says who the visitor is.

/** Who the shop is acting as (the same attributes the browser SDK gets). */
export type Visitor = { userId?: string; country: string; plan: string };

export type Price = { plan: string; price: number; currency: string; newPricing: boolean };

export type PriceSource = (visitor: Visitor) => Promise<Price>;

function isPrice(value: unknown): value is Price {
  const v = value as Partial<Price> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof v.plan === 'string' &&
    typeof v.price === 'number' &&
    typeof v.currency === 'string' &&
    typeof v.newPricing === 'boolean'
  );
}

/** Rejects on any failure; the price card shows "unavailable" rather than a guess. */
export function createPriceSource(options: {
  baseUrl: string;
  serverKey: string;
  fetch?: typeof fetch;
}): PriceSource {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return async (visitor) => {
    const query = new URLSearchParams({
      ...(visitor.userId ? { userId: visitor.userId } : {}),
      country: visitor.country,
      plan: visitor.plan,
    });
    const res = await doFetch(`${options.baseUrl.replace(/\/+$/, '')}/price?${query}`, {
      headers: { 'x-ff-server-key': options.serverKey },
    });
    if (!res.ok) throw new Error(`pricing backend answered ${res.status}`);
    const body: unknown = await res.json();
    if (!isPrice(body)) throw new Error('pricing backend sent an unexpected answer');
    return body;
  };
}
