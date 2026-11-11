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
    let current = true; // answers to an older visitor or version are dropped
    const load = () =>
      source(visitor).then(
        (price) => current && setState({ kind: 'ready', price }),
        () => current && setState({ kind: 'failed' }),
      );
    void load();
    const followUp = version > 0 ? setTimeout(() => void load(), FOLLOW_UP_MS) : undefined;
    return () => {
      current = false;
      clearTimeout(followUp);
    };
  }, [source, visitor, version]);

  return (
    <section aria-label="Price" className={styles.price}>
      {state.kind === 'ready' ? (
        <>
          <span className={styles.amount}>${state.price.price}</span>
          <span className={styles.caption}>
            {state.price.newPricing ? 'New pricing' : 'Regular price'} · {state.price.plan} plan
          </span>
        </>
      ) : (
        <span className={styles.caption}>
          {state.kind === 'loading' ? 'Loading the price…' : 'Price unavailable right now'}
        </span>
      )}
    </section>
  );
}
