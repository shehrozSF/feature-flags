import styles from './Notice.module.css';

export type NoticeValue = { tone: 'info' | 'success' | 'warning' | 'error'; text: string };

/**
 * One status line. Errors are announced at once (alert), everything else politely
 * (status). Both regions are always on the page and only their text changes:
 * screen readers often miss a live region that appears together with its text.
 */
export function Notice({ notice }: { notice: NoticeValue | null }) {
  const isError = notice?.tone === 'error';
  const className = notice ? `${styles.notice} ${styles[notice.tone]}` : undefined;
  return (
    <>
      <p role="alert" className={isError ? className : styles.empty}>
        {isError ? notice.text : null}
      </p>
      <p role="status" className={notice && !isError ? className : styles.empty}>
        {notice && !isError ? notice.text : null}
      </p>
    </>
  );
}
