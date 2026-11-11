import { useState } from 'react';
import type { Sandbox } from '../api';
import { describeError } from '../messages';
import { Notice, type NoticeValue } from './Notice';
import styles from './Welcome.module.css';

/** First visit: explain the demo in one breath and create a sandbox. */
export function Welcome(props: {
  createSandbox: () => Promise<Sandbox>;
  onCreated: (sandbox: Sandbox) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeValue | null>(null);

  const create = async () => {
    setBusy(true);
    setNotice(null);
    try {
      props.onCreated(await props.createSandbox());
    } catch (error) {
      setNotice({ tone: 'error', text: describeError(error) });
      setBusy(false);
    }
  };

  return (
    <section className={styles.welcome}>
      <h2>Try it in 30 seconds</h2>
      <ol className={styles.steps}>
        <li>Create your own sandbox: a private project with four example flags.</li>
        <li>Open the demo shop in another tab.</li>
        <li>Flip a flag here and watch the shop change, live.</li>
      </ol>
      <button className={styles.primary} onClick={() => void create()} disabled={busy}>
        {busy ? 'Creating…' : 'Create my sandbox'}
      </button>
      <p className={styles.small}>No sign-up. Sandboxes expire after 30 days without use.</p>
      <Notice notice={notice} />
    </section>
  );
}
