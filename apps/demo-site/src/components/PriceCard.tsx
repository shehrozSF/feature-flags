// new-pricing, evaluated on a server: the price comes from demo-backend, which
// reads the same sandbox's flags with the server SDK (spec §9.4).
import { useEffect, useState } from 'react';
import { useFlagsVersion } from '../flags';
import type { Price, PriceSource, Visitor } from '../price';
import styles from './Shop.module.css';

/**
 * demo-backend's server SDK reuses rules for up to a second before revalidating,
 * so the first request after a flip can still get the old price. One more request
 * a moment later picks up the new one.
 */
export const FOLLOW_UP_MS = 1500;

type State = { kind: 'loading' } | { kind: 'ready'; price: Price } | { kind: 'failed' };

export function PriceCard({ source, visitor }: { source: PriceSource; visitor: Visitor }) {
  const version = useFlagsVersion(); // changes when any flag changes
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    // Only the newest request may set the price: answers to an older visitor or
    // version, or a slow first request overtaken by the follow-up, are dropped.
    let current = true;
    let sent = 0;
    const load = () => {
      const mine = ++sent;
      const latest = () => current && mine === sent;
      return source(visitor).then(
        (price) => latest() && setState({ kind: 'ready', price }),
        () => latest() && setState({ kind: 'failed' }),
      );
    };
    void load();
    const followUp = version > 0 ? setTimeout(() => void load(), FOLLOW_UP_MS) : undefined;
    return () => {
      current = false;
      clearTimeout(followUp);
    };
  }, [source, visitor, version]);

  // The card always takes the same space, whatever state it's in: no layout jumps.
  return (
    <section aria-label="Price" className={styles.price} data-state={state.kind}>
      {state.kind === 'ready' ? (
        <>
          {/* Keyed by the amount, so a new price gets a brief highlight. */}
          <span key={state.price.price} className={styles.amount}>
            ${state.price.price}
          </span>
          <span className={styles.priceMeta}>
            {state.price.newPricing ? (
              <span className={styles.newPrice}>New pricing</span>
            ) : (
              <span className={styles.caption}>Regular price</span>
            )}
            <span className={styles.caption}>{state.price.plan} plan</span>
          </span>
        </>
      ) : (
        <>
          <span className={styles.amountPlaceholder} aria-hidden="true" />
          <span className={styles.caption}>
            {state.kind === 'loading' ? 'Loading the price…' : 'Price unavailable right now'}
          </span>
        </>
      )}
    </section>
  );
}
