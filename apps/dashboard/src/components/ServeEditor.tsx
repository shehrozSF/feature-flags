import { useId } from 'react';
import { rolloutTotal, toPercent, type DraftServe } from '../draft';
import type { Segment } from '../messages';
import { Field } from './Field';
import { CheckIcon, ErrorIcon, WarningIcon } from './icons';
import { RolloutBar, Swatch } from './RolloutBar';
import styles from './editor.module.css';

/** A variant's stable colour: its position in the flag. */
const colourOf = (variantKeys: string[], key: string) => {
  const i = variantKeys.indexOf(key);
  return i === -1 ? 0 : (i % 10) + 1;
};

/**
 * What a rule (or everyone else) is served: one variant, or a percentage rollout.
 * The two modes are real radio buttons styled as a segmented control. A rollout
 * shows a distribution bar above exact percentage inputs: the bar only helps you
 * see the split; the inputs are what gets saved.
 */
export function ServeEditor(props: {
  serve: DraftServe;
  variantKeys: string[];
  /** '' for the default serve; e.g. "Rule 1: " inside a rule, so labels stay unique. */
  labelPrefix: string;
  name: string;
  errorFor: (path: string) => string | undefined;
  path: string;
  onChange: (serve: DraftServe) => void;
}) {
  const { serve, variantKeys, labelPrefix, onChange } = props;
  const toRollout = (): DraftServe => ({
    mode: 'rollout',
    weights: Object.fromEntries(variantKeys.map((k, i) => [k, i === 0 ? '100' : ''])),
    bucketBy: '',
  });
  const total = serve.mode === 'rollout' ? rolloutTotal(serve.weights, variantKeys) : 0;
  const rolloutError = props.errorFor(`${props.path}.rollout`);
  const rolloutErrorId = `${useId()}-rollout`;

  const barSegments: Segment[] =
    serve.mode === 'rollout'
      ? variantKeys.map((k) => {
          const n = Number(serve.weights[k] ?? '');
          return {
            variant: k,
            weight: Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0,
            colour: colourOf(variantKeys, k),
          };
        })
      : [];
  const exact = total === 10000;

  return (
    <div className={styles.serve}>
      <div className={styles.segmented} role="radiogroup" aria-label={`${labelPrefix}serve`}>
        <label className={styles.segment}>
          <input
            type="radio"
            name={props.name}
            checked={serve.mode === 'variant'}
            onChange={() => onChange({ mode: 'variant', variant: variantKeys[0] ?? '' })}
          />
          <span>One variant</span>
        </label>
        <label className={styles.segment}>
          <input
            type="radio"
            name={props.name}
            checked={serve.mode === 'rollout'}
            onChange={() => onChange(toRollout())}
          />
          <span>Percentage rollout</span>
        </label>
      </div>

      {serve.mode === 'variant' ? (
        <Field label={`${labelPrefix}variant`} hideLabel className={styles.variantPick}>
          {(control) => (
            <span className={styles.selectWrap}>
              <Swatch colour={colourOf(variantKeys, serve.variant)} />
              <select
                {...control}
                className={styles.mono}
                value={serve.variant}
                onChange={(e) => onChange({ mode: 'variant', variant: e.target.value })}
              >
                {variantKeys.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </span>
          )}
        </Field>
      ) : (
        <div className={styles.rollout}>
          <RolloutBar segments={barSegments} size="wide" showRemainder />
          <div className={styles.weights}>
            {variantKeys.map((k) => (
              <Field
                key={k}
                label={`${labelPrefix}${k} %`}
                adornment={<Swatch colour={colourOf(variantKeys, k)} />}
                error={props.errorFor(`${props.path}.weights.${k}`)}
                className={styles.weight}
              >
                {(control) => (
                  <span className={styles.percentWrap}>
                    <input
                      {...control}
                      // The total's message belongs to every weight, next to its own error.
                      aria-describedby={
                        [control['aria-describedby'], rolloutError && rolloutErrorId]
                          .filter(Boolean)
                          .join(' ') || undefined
                      }
                      className={`${styles.percent} ${styles.mono}`}
                      inputMode="decimal"
                      placeholder="0"
                      value={serve.weights[k] ?? ''}
                      onChange={(e) =>
                        onChange({ ...serve, weights: { ...serve.weights, [k]: e.target.value } })
                      }
                    />
                    <span className={styles.percentSign} aria-hidden="true">
                      %
                    </span>
                  </span>
                )}
              </Field>
            ))}
          </div>
          <div className={styles.totalRow} data-exact={exact}>
            <p className={styles.total}>
              {exact ? <CheckIcon size={15} /> : <WarningIcon size={15} />}
              Total: {toPercent(total)}%
            </p>
            {!exact && !rolloutError && (
              <span className={styles.totalHint}>
                {total < 10000
                  ? `${toPercent(10000 - total)}% not assigned yet`
                  : `${toPercent(total - 10000)}% too much`}
              </span>
            )}
          </div>
          {rolloutError && (
            <p id={rolloutErrorId} className={styles.error}>
              <ErrorIcon size={13} />
              {rolloutError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
