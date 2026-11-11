import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircleIcon, ClockIcon, ErrorIcon, InfoIcon } from './icons';
import styles from './Notice.module.css';

export type NoticeValue = {
  tone: 'info' | 'success' | 'warning' | 'error';
  text: string;
  /** e.g. a "Try again" button: errors stay on screen until they're dealt with. */
  action?: ReactNode;
};

const ICONS = {
  info: InfoIcon,
  success: CheckCircleIcon,
  // A delayed propagation is "saved, but slow": a clock, not a failure sign.
  warning: ClockIcon,
  error: ErrorIcon,
} as const;

const TITLES = {
  info: 'Note',
  success: 'Done',
  warning: 'Saved, with a delay',
  error: 'Not done',
} as const;

/**
 * One status line. Errors are announced at once (alert) and stay in place until
 * replaced; everything else is announced politely (status). Success is a quiet
 * toast that floats above the page, so it never pushes the layout around;
 * warnings stay in the flow, where they can be read at leisure.
 *
 * Both regions are always on the page and only their text changes: screen readers
 * often miss a live region that appears together with its text.
 */
export function Notice({ notice }: { notice: NoticeValue | null }) {
  const isError = notice?.tone === 'error';
  const polite = notice && !isError ? notice : null;
  const isToast = polite?.tone === 'success' || polite?.tone === 'info';

  return (
    <>
      <div
        role="alert"
        className={isError ? styles.region : styles.empty}
        data-kind={isError ? 'inline' : 'empty'}
      >
        {isError && <Body notice={notice} />}
      </div>
      <div
        role="status"
        className={polite ? (isToast ? styles.toastRegion : styles.region) : styles.empty}
        data-kind={polite ? (isToast ? 'toast' : 'inline') : 'empty'}
      >
        {/* Keyed by text, so a new message restarts the toast's short life. */}
        {polite && <Body key={`${polite.tone}:${polite.text}`} notice={polite} toast={isToast} />}
      </div>
    </>
  );
}

/** How long a toast stays visible. Its text stays in the live region afterwards. */
const TOAST_MS = 5000;

function Body({ notice, toast = false }: { notice: NoticeValue; toast?: boolean }) {
  const Icon = ICONS[notice.tone];
  const [faded, setFaded] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setFaded(true), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  const toastClass = toast ? `${styles.toast} ${faded ? styles.faded : ''}` : '';
  return (
    <div className={`${styles.notice} ${styles[notice.tone]} ${toastClass}`}>
      <span className={styles.icon}>
        <Icon size={18} />
      </span>
      <span className={styles.content}>
        {!toast && <span className={styles.title}>{TITLES[notice.tone]}</span>}
        <span className={styles.text}>{notice.text}</span>
      </span>
      {notice.action && <span className={styles.action}>{notice.action}</span>}
    </div>
  );
}
