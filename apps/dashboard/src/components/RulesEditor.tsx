import { OPERATORS, type DraftCondition, type DraftRule } from '../draft';
import { Field } from './Field';
import { ServeEditor } from './ServeEditor';
import styles from './editor.module.css';

const OPERATOR_TEXT: Record<string, string> = {
  eq: 'equals',
  in: 'is one of',
  contains: 'contains',
  gt: 'greater than',
  lt: 'less than',
  semverGte: 'version ≥',
};

/** Targeting rules, checked top to bottom; the first match decides (spec §5.2). */
export function RulesEditor(props: {
  rules: DraftRule[];
  variantKeys: string[];
  errorFor: (path: string) => string | undefined;
  onChange: (rules: DraftRule[]) => void;
}) {
  const { rules, variantKeys, onChange } = props;
  const update = (i: number, rule: DraftRule) =>
    onChange(rules.map((r, j) => (j === i ? rule : r)));
  const newId = () => {
    let n = rules.length + 1;
    while (rules.some((r) => r.id === `rule-${n}`)) n++;
    return `rule-${n}`;
  };

  return (
    <fieldset className={styles.group}>
      <legend>Targeting rules</legend>
      {rules.length === 0 && <p className={styles.muted}>No rules: everyone gets the default.</p>}
      {rules.map((rule, i) => {
        const prefix = `Rule ${i + 1}`;
        const setCondition = (j: number, patch: Partial<DraftCondition>) =>
          update(i, {
            ...rule,
            conditions: rule.conditions.map((c, k) => (k === j ? { ...c, ...patch } : c)),
          });
        return (
          <div key={rule.id} className={styles.rule}>
            {rule.conditions.map((c, j) => {
              const label = j === 0 ? prefix : `${prefix} condition ${j + 1}`;
              const path = `rules.${i}.conditions.${j}`;
              return (
                <div key={j} className={styles.row}>
                  <span className={styles.muted}>{j === 0 ? 'If' : 'and'}</span>
                  <Field
                    label={`${label} attribute`}
                    hideLabel
                    error={props.errorFor(`${path}.attribute`)}
                  >
                    {(control) => (
                      <input
                        {...control}
                        placeholder="country"
                        value={c.attribute}
                        onChange={(e) => setCondition(j, { attribute: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label={`${label} operator`} hideLabel>
                    {(control) => (
                      <select
                        {...control}
                        value={c.op}
                        onChange={(e) =>
                          setCondition(j, { op: e.target.value as DraftCondition['op'] })
                        }
                      >
                        {OPERATORS.map((op) => (
                          <option key={op} value={op}>
                            {OPERATOR_TEXT[op]}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field
                    label={`${label} values`}
                    hideLabel
                    error={props.errorFor(`${path}.values`)}
                  >
                    {(control) => (
                      <input
                        {...control}
                        placeholder="PK, IN"
                        value={c.values}
                        onChange={(e) => setCondition(j, { values: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
              );
            })}
            <button
              type="button"
              className={styles.link}
              onClick={() =>
                update(i, {
                  ...rule,
                  conditions: [...rule.conditions, { attribute: '', op: 'eq', values: '' }],
                })
              }
            >
              Add condition
            </button>
            <p className={styles.muted}>then serve</p>
            <ServeEditor
              serve={rule.serve}
              variantKeys={variantKeys}
              labelPrefix={`${prefix}: `}
              name={`rule-${rule.id}-serve`}
              path={`rules.${i}.serve`}
              errorFor={props.errorFor}
              onChange={(serve) => update(i, { ...rule, serve })}
            />
            <button
              type="button"
              className={styles.link}
              onClick={() => onChange(rules.filter((_, j) => j !== i))}
            >
              Remove rule {i + 1}
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className={styles.link}
        onClick={() =>
          onChange([
            ...rules,
            {
              id: newId(),
              conditions: [{ attribute: '', op: 'eq', values: '' }],
              serve: { mode: 'variant', variant: variantKeys[0] ?? '' },
            },
          ])
        }
      >
        Add rule
      </button>
    </fieldset>
  );
}
