// The parts of the demo shop. Each one follows a single seeded flag (spec §9.4),
// so flipping that flag in the dashboard visibly changes exactly that part.
import { useState, type FormEvent } from 'react';
import { useFlag, useFlagsClient, useFlagsStatus } from '../flags';
import type { Visitor } from '../price';
import styles from './Shop.module.css';

/** promo-banner: a banner across the top of the shop. */
export function PromoBanner() {
  if (!useFlag('promo-banner', false)) return null;
  return (
    <section aria-label="Promotion" className={styles.banner}>
      <span className={styles.bannerInner}>
        <span className={styles.bannerTag}>Summer sale</span>
        <span>
          <strong>20% off everything</strong> this week.
        </span>
      </span>
    </section>
  );
}

/** The button colours the shop knows, with the hex codes the sandbox seeds for them. */
const COLOURS = { blue: '#2563eb', green: '#16a34a', red: '#dc2626' } as const;
type Colour = keyof typeof COLOURS;

/** A cta-color value, as a name ("green") or the seeded hex ("#16a34a"); unknown → blue. */
function toColour(value: string): Colour {
  const v = value.trim().toLowerCase();
  const names = Object.keys(COLOURS) as Colour[];
  return names.find((name) => name === v || COLOURS[name] === v) ?? 'blue';
}

/** cta-color: the checkout button's colour (an A/B/C rollout). */
export function CheckoutButton() {
  // <string>: the flag may hold any string, not just the fallback's literal 'blue'.
  const colour = toColour(useFlag<string>('cta-color', 'blue'));
  return (
    <div className={styles.checkout}>
      <button
        type="button"
        className={`${styles.buy} ${styles[colour]}`}
        data-color={colour}
        aria-describedby="buy-note"
      >
        {/* Keyed by colour: a change from the dashboard gets a brief highlight,
            without remounting the button (which would drop keyboard focus). */}
        <span key={colour} className={styles.buyFlash} aria-hidden="true" />
        Buy now
      </button>
      <div className={styles.checkoutMeta}>
        {/* The name too, so colour is never the only way to see the variant. */}
        <p className={styles.caption}>
          <span className={`${styles.swatch} ${styles[colour]}`} aria-hidden="true" />
          Button colour: {colour}
        </p>
        <p id="buy-note" className={styles.caption}>
          Demo only: no order is placed.
        </p>
      </div>
    </div>
  );
}

/** pk-local-payments: local payment methods, targeted at visitors from Pakistan. */
export function LocalPayments() {
  if (!useFlag('pk-local-payments', false)) return null;
  return (
    <section aria-label="Local payments" className={styles.payments}>
      <div className={styles.paymentsText}>
        <h3>Pay locally</h3>
        <p>Mobile wallets for shoppers in Pakistan.</p>
      </div>
      <ul className={styles.wallets}>
        <li className={styles.wallet}>
          <WalletGlyph />
          JazzCash
        </li>
        <li className={styles.wallet}>
          <WalletGlyph />
          Easypaisa
        </li>
      </ul>
    </section>
  );
}

function WalletGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect
        x="3"
        y="6"
        width="18"
        height="13"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path d="M16 12.5h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M6 6l9-3 1 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export const COUNTRIES = [
  ['US', 'United States'],
  ['PK', 'Pakistan'],
  ['GB', 'United Kingdom'],
  ['IN', 'India'],
  ['DE', 'Germany'],
] as const;

/** Switch the visitor (spec §9.4): sets userId, country and plan, then identify(). */
export function ActAsUser({ onActAs }: { onActAs?: (visitor: Visitor) => void }) {
  const client = useFlagsClient();
  const [userId, setUserId] = useState('');
  const [country, setCountry] = useState('US');
  const [plan, setPlan] = useState('free');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const id = userId.trim();
    const visitor: Visitor = { ...(id ? { userId: id } : {}), country, plan };
    void client.identify(visitor);
    onActAs?.(visitor); // the pricing backend gets the same visitor
  };

  return (
    <form className={styles.actAs} onSubmit={submit} aria-label="Act as user">
      <h3>Act as a visitor</h3>
      <label>
        User ID
        <input
          value={userId}
          placeholder="anonymous"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setUserId(e.target.value)}
        />
      </label>
      <div className={styles.pair}>
        <label>
          Country
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Plan
          <select value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="free">free</option>
            <option value="pro">pro</option>
          </select>
        </label>
      </div>
      <button type="submit">Act as this user</button>
    </form>
  );
}

const STATUS_TEXT = {
  loading: 'Connecting…',
  live: 'Live updates',
  offline: 'Offline: showing saved values',
} as const;

/** Whether the shop is connected (spec §1.2: cached values when the API is down). */
export function Status() {
  const status = useFlagsStatus();
  return (
    <p role="status" className={`${styles.status} ${styles[status]}`}>
      <span className={styles.dot} aria-hidden="true" /> {STATUS_TEXT[status]}
    </p>
  );
}
