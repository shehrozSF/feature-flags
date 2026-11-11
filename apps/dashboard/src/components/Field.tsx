import { useId, type ReactElement } from 'react';
import styles from './editor.module.css';

/**
 * A label, one control and its error. The error is linked with aria-describedby,
 * so screen readers read it with the field (spec: accessible errors next to fields).
 */
export function Field(props: {
  label: string;
  error?: string | undefined;
  hideLabel?: boolean;
  children: (control: {
    id: string;
    'aria-describedby'?: string;
    'aria-invalid'?: true;
  }) => ReactElement;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={props.hideLabel ? styles.visuallyHidden : styles.label}>
        {props.label}
      </label>
      {props.children(
        props.error ? { id, 'aria-describedby': errorId, 'aria-invalid': true } : { id },
      )}
      {props.error && (
        <p id={errorId} className={styles.error}>
          {props.error}
        </p>
      )}
    </div>
  );
}
