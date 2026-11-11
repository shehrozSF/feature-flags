import type { FlagResource } from '@ff/contracts';
import { useEffect, useState } from 'react';
import { ApiError, type AdminApi } from '../api';
import { describeError, describeServing } from '../messages';
import { Notice, type NoticeValue } from './Notice';
import styles from './FlagList.module.css';

/** The sandbox's flags, each with an on/off switch. */
export function FlagList({ api }: { api: AdminApi }) {
  const [flags, setFlags] = useState<FlagResource[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeValue | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listFlags().then(
      (loaded) => !cancelled && setFlags(loaded),
      (error: unknown) => !cancelled && setNotice({ tone: 'error', text: describeError(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [api]);

  const replace = (next: FlagResource) =>
    setFlags((current) => current?.map((f) => (f.key === next.key ? next : f)) ?? null);

  const toggle = async (flag: FlagResource) => {
    setBusyKey(flag.key);
    setNotice(null);
    try {
      const saved = await api.updateFlag(flag.key, flag.version, { enabled: !flag.enabled });
      replace(saved.value);
      setNotice(
        saved.propagation === 'delayed'
          ? { tone: 'warning', text: 'Saved. The demo will catch up within a minute.' }
          : {
              tone: 'success',
              text: `Saved: ${flag.name} is now ${saved.value.enabled ? 'on' : 'off'}.`,
            },
      );
    } catch (error) {
      // Someone saved first: show what they saved, so the next click starts from it.
      if (error instanceof ApiError && error.problem.kind === 'conflict') {
        replace(error.problem.current);
        setNotice({ tone: 'warning', text: describeError(error) });
      } else {
        setNotice({ tone: 'error', text: describeError(error) });
      }
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <section className={styles.section} aria-labelledby="flags-heading">
      <h2 id="flags-heading">Flags</h2>
      <Notice notice={notice} />
      {flags === null && !notice && <p className={styles.muted}>Loading flags…</p>}
      {flags && (
        <ul className={styles.list}>
          {flags.map((flag) => (
            <li key={flag.key} className={styles.row}>
              <div className={styles.text}>
                <span className={styles.name}>{flag.name}</span>
                <code className={styles.key}>{flag.key}</code>
                <span className={styles.summary}>{describeServing(flag)}</span>
              </div>
              <button
                role="switch"
                aria-checked={flag.enabled}
                aria-label={flag.name}
                className={styles.switch}
                disabled={busyKey === flag.key}
                onClick={() => void toggle(flag)}
              >
                <span className={styles.track} aria-hidden="true">
                  <span className={styles.thumb} />
                </span>
                <span className={styles.state}>{flag.enabled ? 'On' : 'Off'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
