import { useId, type ReactElement, type ReactNode } from 'react';
import { ErrorIcon } from './icons';
import styles from './editor.module.css';

/**
 * A label, one control, an optional hint and its error. The hint and the error are
 * linked with aria-describedby, so screen readers read them with the field (spec:
 * accessible errors next to fields). The error always appears in the same place:
 * directly under its control.
 *
 * `hideLabel` keeps the full label for assistive tech ("Rule 1 attribute") while
 * `caption` shows a short visible one ("Attribute") where columns give context.
 */
export function Field(props: {
  label: string;
  error?: string | undefined;
  hideLabel?: boolean;
  caption?: string;
  hint?: ReactNode;
  /** Decoration inside the label, e.g. a colour swatch (must carry no text). */
  adornment?: ReactNode;
  className?: string | undefined;
  children: (control: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
  }) => ReactElement;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy =
    [props.hint ? hintId : null, props.error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;
  const control = {
    id,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
    ...(props.error ? { 'aria-invalid': true as const } : {}),
  };

  return (
    <div className={`${styles.field} ${props.className ?? ''}`}>
      {props.caption && (
        <span className={styles.caption} aria-hidden="true">
          {props.caption}
        </span>
      )}
      <label htmlFor={id} className={props.hideLabel ? styles.visuallyHidden : styles.label}>
        {props.adornment}
        {props.label}
      </label>
      {props.children(control)}
      {props.hint && (
        <p id={hintId} className={styles.hint}>
          {props.hint}
        </p>
      )}
      {props.error && (
        <p id={errorId} className={styles.error}>
          <ErrorIcon size={13} />
          {props.error}
        </p>
      )}
    </div>
  );
}
