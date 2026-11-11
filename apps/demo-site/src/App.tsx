// The demo shop (spec §3, §9.4): what a visitor sees change when a flag is flipped
// in the dashboard. Without sandbox keys it explains how to start instead.
import type { BrowserClient } from '@ff/sdk-client';
import styles from './App.module.css';
import { ActAsUser, CheckoutButton, LocalPayments, PromoBanner, Status } from './components/Shop';
import { FlagsProvider } from './flags';

export function App(props: { client: BrowserClient | null; dashboardUrl: string }) {
  if (!props.client) {
    return (
      <main className={styles.start}>
        <h1>Open this from your dashboard</h1>
        <p>
          This demo shop shows the flags of your own sandbox. Create one in the dashboard, then use
          its <strong>Open the demo site</strong> button.
        </p>
        <a className={styles.cta} href={props.dashboardUrl}>
          Go to the dashboard
        </a>
      </main>
    );
  }

  return (
    <FlagsProvider client={props.client}>
      <div className={styles.page}>
        <header className={styles.header}>
          <span className={styles.logo}>Demo shop</span>
          <Status />
        </header>
        <PromoBanner />
        <main className={styles.main}>
          <article className={styles.product}>
            <div className={styles.picture} aria-hidden="true" />
            <div className={styles.details}>
              <h1>Everyday backpack</h1>
              <p className={styles.muted}>Waterproof, 20 litres, made to last.</p>
              <CheckoutButton />
              <LocalPayments />
            </div>
          </article>
          <aside>
            <ActAsUser />
          </aside>
        </main>
      </div>
    </FlagsProvider>
  );
}
