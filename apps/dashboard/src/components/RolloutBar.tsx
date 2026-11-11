import { percent, type Segment } from '../messages';
import styles from './RolloutBar.module.css';

/**
 * A distribution bar: one segment per variant, in the variant's stable colour.
 * Pure decoration (aria-hidden): the same numbers are always written out next to
 * it as text or inputs, so colour is never the only way to read it.
 */
export function RolloutBar(props: {
  segments: Segment[];
  size?: 'mini' | 'wide';
  /** Show the part of 100% that isn't assigned (while editing a rollout). */
  showRemainder?: boolean;
  dimmed?: boolean;
}) {
  const total = props.segments.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  const scale = Math.max(total, 10000);
  const remainder = props.showRemainder ? Math.max(0, 10000 - total) : 0;
  const className = [
    styles.bar,
    props.size === 'wide' ? styles.wide : styles.mini,
    props.dimmed ? styles.dimmed : '',
  ].join(' ');
  return (
    <span className={className} aria-hidden="true">
      {props.segments
        .filter((s) => s.weight > 0)
        .map((s) => (
          <span
            key={s.variant}
            className={styles.segment}
            style={{
              flexGrow: s.weight / scale,
              background: s.colour ? `var(--v${s.colour})` : 'var(--text-faint)',
            }}
            title={`${s.variant} ${percent(s.weight)}`}
          />
        ))}
      {remainder > 0 && (
        <span className={styles.remainder} style={{ flexGrow: remainder / scale }} />
      )}
    </span>
  );
}

/** A small colour swatch for a variant, beside its name. */
export function Swatch({ colour }: { colour: number }) {
  return (
    <span
      className={styles.swatch}
      style={{ background: colour ? `var(--v${colour})` : 'var(--text-faint)' }}
      aria-hidden="true"
    />
  );
}
