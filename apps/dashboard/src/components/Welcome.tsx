import { useState } from 'react';
import type { Sandbox } from '../api';
import { describeError } from '../messages';
import { ArrowRightIcon, SpinnerIcon } from './icons';
import { Notice, type NoticeValue } from './Notice';
import styles from './Welcome.module.css';
import ui from './ui.module.css';

const STEPS = [
  {
    title: 'Create',
    text: 'Your own sandbox: a private project with four example flags.',
  },
  {
    title: 'Open demo',
    text: 'Open the demo shop in another tab, side by side with this one.',
  },
  {
    title: 'Change it live',
    text: 'Flip a flag or change a rollout here, and watch the shop follow it.',
  },
];

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
    <div className={styles.welcome}>
      <section className={styles.intro} aria-labelledby="welcome-title">
        <p className={styles.eyebrow}>Feature flags · live demo</p>
        <h1 id="welcome-title" className={styles.headline}>
          Ship the switch. <span className={styles.accent}>See the change.</span>
        </h1>
        <p className={styles.lede}>
          A feature-flag service you can try in seconds. Turn features on and off, target visitors
          by country or plan, and roll out to a percentage, then watch a real demo shop change
          without a reload.
        </p>
        <div className={styles.cta}>
          <button
            className={`${ui.btn} ${ui.primary} ${ui.lg}`}
            onClick={() => void create()}
            disabled={busy}
          >
            {busy ? (
              <>
                <SpinnerIcon size={16} className={ui.spin} />
                Creating…
              </>
            ) : (
              <>
                Create my sandbox
                <ArrowRightIcon size={16} />
              </>
            )}
          </button>
          <p className={styles.quiet}>No signup. Your own sandbox.</p>
        </div>
        <Notice notice={notice} />
        <p className={styles.small}>
          Sandboxes are deleted after 30 days without use, together with their flags and keys.
        </p>
      </section>

      <Illustration />

      <ol className={styles.steps} aria-label="How it works">
        {STEPS.map((step, i) => (
          <li
            key={step.title}
            className={styles.step}
            style={{ animationDelay: `${200 + i * 70}ms` }}
          >
            <span className={styles.stepNo} aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <span className={styles.stepTitle}>{step.title}</span>
            <span className={styles.stepText}>{step.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A picture of the idea, not a working control: a switch wired to a tiny shop
 * whose banner appears when the switch turns on. It plays once, and says plainly
 * that it isn't connected to anything.
 */
function Illustration() {
  return (
    <figure className={styles.figure}>
      <div className={styles.stage} aria-hidden="true">
        <div className={styles.console}>
          <div className={styles.consoleHead}>
            <span className={styles.dots}>
              <i />
              <i />
              <i />
            </span>
            <span className={styles.consoleTitle}>Dashboard</span>
          </div>
          <div className={styles.flagRow}>
            <span className={styles.flagText}>
              <b>Promo banner</b>
              <code>promo-banner</code>
            </span>
            <span className={styles.demoSwitch}>
              <span className={styles.demoThumb} />
            </span>
          </div>
          <div className={`${styles.flagRow} ${styles.flagRowDim}`}>
            <span className={styles.flagText}>
              <b>Checkout colour</b>
              <code>cta-color</code>
            </span>
            <span className={styles.demoBar}>
              <i />
              <i />
              <i />
            </span>
          </div>
        </div>

        <svg className={styles.wire} viewBox="0 0 100 40" preserveAspectRatio="none">
          <path d="M0 20 C 35 20, 65 20, 100 20" className={styles.wirePath} />
          <path d="M0 20 C 35 20, 65 20, 100 20" className={styles.wirePulse} />
        </svg>

        <div className={styles.shop}>
          <div className={styles.shopHead}>
            <span className={styles.shopMark}>Larkspur</span>
            <span className={styles.shopNav}>
              <i />
              <i />
            </span>
          </div>
          <div className={styles.shopBanner}>Summer sale · 20% off</div>
          <div className={styles.shopBody}>
            <span className={styles.shopPicture} />
            <span className={styles.shopLines}>
              <i />
              <i />
              <i className={styles.shopButton} />
            </span>
          </div>
        </div>
      </div>
      <figcaption className={styles.caption}>
        Illustration: turning on a flag shows the shop's banner. Not connected to your sandbox.
      </figcaption>
    </figure>
  );
}
