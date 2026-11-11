import type { DraftVariant } from '../draft';
import { Field } from './Field';
import styles from './editor.module.css';

/** The values a flag can serve. Values are JSON: true, "blue", 19, {"a":1}. */
export function VariantsEditor(props: {
  variants: DraftVariant[];
  errorFor: (path: string) => string | undefined;
  onChange: (variants: DraftVariant[]) => void;
}) {
  const { variants, onChange } = props;
  const update = (i: number, patch: Partial<DraftVariant>) =>
    onChange(variants.map((v, j) => (j === i ? { ...v, ...patch } : v)));

  return (
    <fieldset className={styles.group}>
      <legend>Variants</legend>
      {variants.map((v, i) => (
        <div key={i} className={styles.row}>
          <Field label={`Variant ${i + 1} key`} error={props.errorFor(`variants.${i}.key`)}>
            {(control) => (
              <input
                {...control}
                value={v.key}
                onChange={(e) => update(i, { key: e.target.value })}
              />
            )}
          </Field>
          <Field label={`Variant ${i + 1} value`} error={props.errorFor(`variants.${i}.value`)}>
            {(control) => (
              <input
                {...control}
                className={styles.mono}
                value={v.value}
                onChange={(e) => update(i, { value: e.target.value })}
              />
            )}
          </Field>
          <button
            type="button"
            className={styles.link}
            disabled={variants.length <= 1}
            onClick={() => onChange(variants.filter((_, j) => j !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className={styles.link}
        onClick={() =>
          onChange([...variants, { key: `variant-${variants.length + 1}`, value: '""' }])
        }
      >
        Add variant
      </button>
    </fieldset>
  );
}
