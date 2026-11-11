// The dashboard (spec §3.1, plan Task 3): create a sandbox, then flip its flags
// and open the demo shop. Dependencies are props with real defaults, so component
// tests can hand in fakes.
import { useMemo, useState } from 'react';
import { createAdminApi, createSandbox, type AdminApi, type Sandbox } from './api';
import styles from './App.module.css';
import { FlagList } from './components/FlagList';
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

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Feature flags</h1>
        <p className={styles.tagline}>Flip a flag, watch a website change. Live.</p>
      </header>
      <main className={styles.main}>
        {!sandbox || !api ? (
          <Welcome createSandbox={create} onCreated={created} />
        ) : (
          <>
            <div className={styles.toolbar}>
              <a
                className={styles.demoLink}
                href={demoLink(props.demoUrl ?? DEMO_URL, sandbox.keys)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Open the demo site ↗
              </a>
              <button className={styles.secondary} onClick={startOver}>
                Start over
              </button>
            </div>
            <FlagList api={api} confirm={confirm} />
          </>
        )}
      </main>
    </div>
  );
}
