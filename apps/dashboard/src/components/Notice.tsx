import styles from './Notice.module.css';

export type NoticeValue = { tone: 'info' | 'success' | 'warning' | 'error'; text: string };

/** One status line. Errors are announced at once (alert), everything else politely. */
export function Notice({ notice }: { notice: NoticeValue | null }) {
  if (!notice) return null;
  return (
    <p
      className={`${styles.notice} ${styles[notice.tone]}`}
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      {notice.text}
    </p>
  );
}
