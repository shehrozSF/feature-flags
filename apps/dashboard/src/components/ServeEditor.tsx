import { useId } from 'react';
import { rolloutTotal, toPercent, type DraftServe } from '../draft';
import { Field } from './Field';
import styles from './editor.module.css';

/** What a rule (or everyone else) is served: one variant, or a percentage rollout. */
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

  return (
    <div className={styles.serve}>
      <div className={styles.radios} role="radiogroup" aria-label={`${labelPrefix}serve`}>
        <label>
          <input
            type="radio"
            name={props.name}
            checked={serve.mode === 'variant'}
            onChange={() => onChange({ mode: 'variant', variant: variantKeys[0] ?? '' })}
          />{' '}
          One variant
        </label>
        <label>
          <input
            type="radio"
            name={props.name}
            checked={serve.mode === 'rollout'}
            onChange={() => onChange(toRollout())}
          />{' '}
          Percentage rollout
        </label>
      </div>

      {serve.mode === 'variant' ? (
        <Field label={`${labelPrefix}variant`} hideLabel>
          {(control) => (
            <select
              {...control}
              value={serve.variant}
              onChange={(e) => onChange({ mode: 'variant', variant: e.target.value })}
            >
              {variantKeys.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : (
        <div className={styles.weights}>
          {variantKeys.map((k) => (
            <Field
              key={k}
              label={`${labelPrefix}${k} %`}
              error={props.errorFor(`${props.path}.weights.${k}`)}
            >
              {(control) => (
                <input
                  {...control}
                  // The total's message belongs to every weight, next to its own error.
                  aria-describedby={
                    [control['aria-describedby'], rolloutError && rolloutErrorId]
                      .filter(Boolean)
                      .join(' ') || undefined
                  }
                  className={styles.percent}
                  inputMode="decimal"
                  value={serve.weights[k] ?? ''}
                  onChange={(e) =>
                    onChange({ ...serve, weights: { ...serve.weights, [k]: e.target.value } })
                  }
                />
              )}
            </Field>
          ))}
          <p className={styles.total}>Total: {toPercent(total)}%</p>
          {rolloutError && (
            <p id={rolloutErrorId} className={styles.error}>
              {rolloutError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
