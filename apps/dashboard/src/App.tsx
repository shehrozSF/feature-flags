// The dashboard (spec §3.1, plan Task 3): create a sandbox, then flip its flags
// and open the demo shop. Dependencies are props with real defaults, so component
// tests can hand in fakes.
import { useMemo, useState } from 'react';
import { createAdminApi, createSandbox, type AdminApi, type Sandbox } from './api';
import styles from './App.module.css';
import { FlagList } from './components/FlagList';
import { ExternalIcon, FlagMark, RefreshIcon } from './components/icons';
import ui from './components/ui.module.css';
import { Welcome } from './components/Welcome';
import { API_URL, DEMO_URL } from './config';
import { demoLink, forgetSandbox, loadSandbox, saveSandbox } from './sandbox';

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export type AppProps = {
  storage?: Storage | null;
  createSandbox?: () => Promise<Sandbox>;
  makeApi?: (adminKey: string) => AdminApi;
  demoUrl?: string;
  confirm?: (message: string) => boolean;
};

export function App(props: AppProps) {
  const storage = props.storage === undefined ? browserStorage() : props.storage;
  const create = props.createSandbox ?? (() => createSandbox(API_URL));
  const makeApi = props.makeApi ?? ((adminKey) => createAdminApi({ baseUrl: API_URL, adminKey }));
  const confirm = props.confirm ?? ((message) => window.confirm(message));

  const [sandbox, setSandbox] = useState<Sandbox | null>(() => loadSandbox(storage));
  const adminKey = sandbox?.keys.admin;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one client per sandbox, not per render
  const api = useMemo(() => (adminKey ? makeApi(adminKey) : null), [adminKey]);

  const created = (next: Sandbox) => {
    saveSandbox(storage, next);
    setSandbox(next);
  };

  const startOver = () => {
    if (
      !confirm(
        'Forget this sandbox and start a new one? Its flags stay on the server until they expire.',
      )
    ) {
      return;
    }
    forgetSandbox(storage);
    setSandbox(null);
  };

  const demoHref = sandbox ? demoLink(props.demoUrl ?? DEMO_URL, sandbox.keys) : null;

  return (
    <div className={styles.app}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <span className={styles.brand}>
            <FlagMark size={28} />
            <span className={styles.wordmark}>Feature flags</span>
          </span>
          {sandbox && (
            <span className={styles.context}>
              <span className={styles.slash} aria-hidden="true">
                /
              </span>
              <span className={`${ui.badge} ${ui.badgeAccent}`}>
                <span className={ui.dot} aria-hidden="true" />
                Personal sandbox
              </span>
              <code className={styles.projectId} title={`Project ${sandbox.projectId}`}>
                <span className={ui.visuallyHidden}>Project </span>
                {sandbox.projectId.slice(0, 8)}
              </code>
            </span>
          )}
          {demoHref && (
            <a className={styles.topLink} href={demoHref} target="_blank" rel="noopener noreferrer">
              Demo shop
              <span className={ui.visuallyHidden}> (opens in a new tab)</span>
              <ExternalIcon size={14} />
            </a>
          )}
        </div>
      </header>

      <main className={styles.main}>
        {!sandbox || !api ? (
          <Welcome createSandbox={create} onCreated={created} />
        ) : (
          <FlagList
            api={api}
            confirm={confirm}
            onStartOver={startOver}
            intro={
              <section className={styles.hero} aria-labelledby="sandbox-title">
                <div className={styles.heroText}>
                  <p className={styles.eyebrow}>Control room</p>
                  <h1 id="sandbox-title" className={styles.title}>
                    Your flags
                  </h1>
                  <p className={styles.lede}>
                    Every switch here drives the demo shop. Open the shop beside this tab, flip a
                    flag, and watch it change for its visitors.
                  </p>
                </div>
                <a
                  className={`${ui.btn} ${ui.primary} ${ui.lg}`}
                  href={demoHref!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open the demo site ↗
                </a>
              </section>
            }
            footer={
              <section className={styles.sandboxActions} aria-labelledby="sandbox-actions">
                <div className={styles.sandboxText}>
                  <h2 id="sandbox-actions">Sandbox</h2>
                  <p>
                    Kept in this browser. Its flags and keys are deleted after 30 days without
                    dashboard use.
                  </p>
                </div>
                <button className={`${ui.btn} ${ui.ghost} ${ui.sm}`} onClick={startOver}>
                  <RefreshIcon size={14} />
                  Start over
                </button>
              </section>
            }
          />
        )}
      </main>
    </div>
  );
}
