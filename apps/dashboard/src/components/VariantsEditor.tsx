import { LIMITS } from '@ff/contracts';
import type { DraftVariant } from '../draft';
import { Field } from './Field';
import { PlusIcon } from './icons';
import { Swatch } from './RolloutBar';
import styles from './editor.module.css';
import ui from './ui.module.css';

export type JsonKind = 'Boolean' | 'String' | 'Number' | 'Array' | 'Object' | 'Null';

/** What JSON a variant's text holds, or null while it isn't valid JSON yet. */
export function jsonKind(text: string): JsonKind | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null) return 'Null';
  if (Array.isArray(value)) return 'Array';
  switch (typeof value) {
    case 'boolean':
      return 'Boolean';
    case 'string':
      return 'String';
    case 'number':
      return 'Number';
    default:
      return 'Object';
  }
}

/** The values a flag can serve. Values are JSON: true, "blue", 19, {"a":1}. */
export function VariantsEditor(props: {
  variants: DraftVariant[];
  errorFor: (path: string) => string | undefined;
  onChange: (variants: DraftVariant[]) => void;
}) {
  const { variants, onChange } = props;
  const update = (i: number, patch: Partial<DraftVariant>) =>
    onChange(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  const full = variants.length >= LIMITS.variantsPerFlag;

  return (
    <div className={styles.variants}>
      <div className={styles.variantColumns} aria-hidden="true">
        <span />
        <span>Key</span>
        <span>Value (JSON)</span>
        <span>Type</span>
        <span />
      </div>
      {variants.map((v, i) => {
        const kind = jsonKind(v.value);
        return (
          <div key={i} className={styles.variantRow}>
            <span className={styles.variantSwatch}>
              <Swatch colour={(i % 10) + 1} />
            </span>
            <Field
              label={`Variant ${i + 1} key`}
              hideLabel
              caption="Key"
              error={props.errorFor(`variants.${i}.key`)}
            >
              {(control) => (
                <input
                  {...control}
                  className={styles.mono}
                  spellCheck={false}
                  autoComplete="off"
                  value={v.key}
                  onChange={(e) => update(i, { key: e.target.value })}
                />
              )}
            </Field>
            <Field
              label={`Variant ${i + 1} value`}
              hideLabel
              caption="Value (JSON)"
              error={props.errorFor(`variants.${i}.value`)}
            >
              {(control) => (
                <input
                  {...control}
                  className={`${styles.mono} ${styles.json}`}
                  data-kind={kind ?? 'invalid'}
                  spellCheck={false}
                  autoComplete="off"
                  value={v.value}
                  onChange={(e) => update(i, { value: e.target.value })}
                />
              )}
            </Field>
            <span className={styles.variantType}>
              {kind ? (
                <span className={ui.badge} data-kind={kind}>
                  {kind}
                </span>
              ) : (
                <span className={`${ui.badge} ${ui.badgeDanger}`}>
                  {v.value.trim() === '' ? 'Empty' : 'Invalid JSON'}
                </span>
              )}
            </span>
            <button
              type="button"
              className={`${ui.textBtn} ${styles.remove}`}
              aria-label={`Remove variant ${i + 1}`}
              title={variants.length <= 1 ? 'A flag needs at least one variant' : undefined}
              disabled={variants.length <= 1}
              onClick={() => onChange(variants.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </div>
        );
      })}
      <div className={styles.variantFoot}>
        <button
          type="button"
          className={ui.textBtn}
          disabled={full}
          onClick={() =>
            onChange([...variants, { key: `variant-${variants.length + 1}`, value: '""' }])
          }
        >
          <PlusIcon size={14} />
          Add variant
        </button>
        <p className={styles.hint}>
          {full ? (
            `A flag can have up to ${LIMITS.variantsPerFlag} variants.`
          ) : (
            <>
              Values are JSON: <code>true</code>, <code>"blue"</code>, <code>19</code>,{' '}
              <code>{'{"limit": 3}'}</code>. Text needs quotes.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
