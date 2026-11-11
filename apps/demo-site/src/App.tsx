// The demo shop (spec §3, §9.4): what a visitor sees change when a flag is flipped
// in the dashboard. Without sandbox keys it explains how to start instead.
import type { BrowserClient } from '@ff/sdk-client';
import { useState } from 'react';
import styles from './App.module.css';
import backpack from './assets/backpack.svg';
import { PriceCard } from './components/PriceCard';
import {
  ActAsUser,
  CheckoutButton,
  COUNTRIES,
  LocalPayments,
  PromoBanner,
  Status,
} from './components/Shop';
import { FlagsProvider } from './flags';
import type { PriceSource, Visitor } from './price';

/** The visitor the browser SDK starts with (main.tsx gives it the same context). */
export const FIRST_VISITOR: Visitor = { country: 'US', plan: 'free' };

const countryName = (code: string) => COUNTRIES.find(([c]) => c === code)?.[1] ?? code;

function Wordmark() {
  return (
    <span className={styles.wordmark}>
      Larkspur<span className={styles.wordmarkSub}>Supply Co.</span>
    </span>
  );
}

export function App(props: {
  client: BrowserClient | null;
  dashboardUrl: string;
  /** The pricing backend; without it the shop shows no price. */
  priceSource?: PriceSource | undefined;
}) {
  // Held here so the price card asks the backend about the same visitor.
  const [visitor, setVisitor] = useState<Visitor>(FIRST_VISITOR);

  if (!props.client) {
    return (
      <div className={styles.startPage}>
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <Wordmark />
          </div>
        </header>
        <main className={styles.start}>
          <img className={styles.startImage} src={backpack} alt="" />
          <div className={styles.startText}>
            <p className={styles.eyebrow}>Feature flags demo shop</p>
            <h1>Open this from your dashboard</h1>
            <p>
              This demo shop shows the flags of your own sandbox. Create one in the dashboard, then
              use its <strong>Open the demo site</strong> button.
            </p>
            <a className={styles.cta} href={props.dashboardUrl}>
              Go to the dashboard
            </a>
          </div>
        </main>
      </div>
    );
  }

  return (
    <FlagsProvider client={props.client}>
      <div className={styles.page}>
        <PromoBanner />
        <header className={styles.header}>
          <div className={styles.headerInner}>
            <Wordmark />
            <span className={styles.headerNote}>Demo store</span>
          </div>
        </header>

        <main className={styles.main}>
          <article className={styles.product} aria-labelledby="product-title">
            <div className={styles.gallery}>
              <img
                className={styles.picture}
                src={backpack}
                width={800}
                height={900}
                alt="The Everyday backpack in olive waxed canvas, with a front flap, two tan leather straps with brass buckles, and a zipped front pocket."
              />
            </div>
            <div className={styles.details}>
              <p className={styles.eyebrow}>Bags · Everyday carry</p>
              <h1 id="product-title" className={styles.title}>
                Everyday backpack
              </h1>
              <p className={styles.lede}>Waterproof, 20 litres, made to last.</p>
              {props.priceSource && <PriceCard source={props.priceSource} visitor={visitor} />}
              <CheckoutButton />
              <LocalPayments />
              <ul className={styles.features}>
                <li>Waxed cotton canvas</li>
                <li>Vegetable-tanned leather straps</li>
                <li>Padded 15″ laptop sleeve</li>
              </ul>
            </div>
          </article>

          <aside className={styles.preview} aria-labelledby="preview-title">
            <div className={styles.previewHead}>
              <h2 id="preview-title">Preview controls</h2>
              <Status />
            </div>
            <p className={styles.previewText}>
              Not part of the shop. Choose who the shop thinks you are: flags are evaluated for this
              visitor.
            </p>
            <p className={styles.previewVisitor}>
              <span>Now showing</span>
              {visitor.userId ?? 'anonymous'} · {countryName(visitor.country)} · {visitor.plan}
            </p>
            <ActAsUser onActAs={setVisitor} />
          </aside>
        </main>

        <footer className={styles.footer}>
          <Wordmark />
          <p>A demo shop for the feature flags project. Nothing here is for sale.</p>
        </footer>
      </div>
    </FlagsProvider>
  );
}
