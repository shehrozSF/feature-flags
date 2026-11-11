import { LIMITS } from '@ff/contracts';
import { OPERATORS, type DraftCondition, type DraftRule } from '../draft';
import { OPERATOR_TEXT } from '../messages';
import { Field } from './Field';
import { PlusIcon, TrashIcon } from './icons';
import { ServeEditor } from './ServeEditor';
import styles from './editor.module.css';
import ui from './ui.module.css';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Targeting rules, checked top to bottom; the first match decides (spec §5.2).
 * The order on screen is the evaluation order: the connector line down the left
 * reads like a flow, ending in "otherwise" (the default behaviour).
 */
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
  const full = rules.length >= LIMITS.rulesPerFlag;

  return (
    <div className={styles.rules}>
      {rules.length === 0 ? (
        <p className={styles.noRules}>No rules: every visitor gets the default behaviour below.</p>
      ) : (
        <ol className={styles.ruleList}>
          {rules.map((rule, i) => {
            const prefix = `Rule ${i + 1}`;
            const setCondition = (j: number, patch: Partial<DraftCondition>) =>
              update(i, {
                ...rule,
                conditions: rule.conditions.map((c, k) => (k === j ? { ...c, ...patch } : c)),
              });
            const conditionsFull = rule.conditions.length >= LIMITS.conditionsPerRule;
            return (
              <li key={rule.id} className={styles.rule}>
                <span className={styles.ruleNode} aria-hidden="true">
                  {pad(i + 1)}
                </span>
                <div className={styles.ruleCard}>
                  <div className={styles.ruleHead}>
                    <span className={styles.ruleTitle}>Rule {pad(i + 1)}</span>
                    <button
                      type="button"
                      className={`${ui.textBtn} ${styles.removeRule}`}
                      onClick={() => onChange(rules.filter((_, j) => j !== i))}
                    >
                      <TrashIcon size={14} />
                      Remove rule {i + 1}
                    </button>
                  </div>

                  <div className={styles.conditions}>
                    {rule.conditions.map((c, j) => {
                      const label = j === 0 ? prefix : `${prefix} condition ${j + 1}`;
                      const path = `rules.${i}.conditions.${j}`;
                      return (
                        <div key={j} className={styles.condition}>
                          <span className={styles.keyword}>{j === 0 ? 'If' : 'And'}</span>
                          <div className={styles.conditionFields}>
                            <Field
                              label={`${label} attribute`}
                              hideLabel
                              caption="Attribute"
                              error={props.errorFor(`${path}.attribute`)}
                            >
                              {(control) => (
                                <input
                                  {...control}
                                  className={styles.mono}
                                  spellCheck={false}
                                  autoComplete="off"
                                  placeholder="country"
                                  value={c.attribute}
                                  onChange={(e) => setCondition(j, { attribute: e.target.value })}
                                />
                              )}
                            </Field>
                            <Field label={`${label} operator`} hideLabel caption="Operator">
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
                              caption={c.op === 'in' ? 'Values, comma-separated' : 'Value'}
                              error={props.errorFor(`${path}.values`)}
                            >
                              {(control) => (
                                <input
                                  {...control}
                                  className={styles.mono}
                                  spellCheck={false}
                                  autoComplete="off"
                                  placeholder={
                                    c.op === 'gt' || c.op === 'lt'
                                      ? '18'
                                      : c.op === 'semverGte'
                                        ? '2.1.0'
                                        : 'PK, IN'
                                  }
                                  value={c.values}
                                  onChange={(e) => setCondition(j, { values: e.target.value })}
                                />
                              )}
                            </Field>
                          </div>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className={`${ui.textBtn} ${styles.addCondition}`}
                      aria-label={`Add condition to rule ${i + 1}`}
                      disabled={conditionsFull}
                      onClick={() =>
                        update(i, {
                          ...rule,
                          conditions: [...rule.conditions, { attribute: '', op: 'eq', values: '' }],
                        })
                      }
                    >
                      <PlusIcon size={14} />
                      Add condition
                    </button>
                  </div>

                  <div className={styles.outcome}>
                    <span className={styles.keyword}>Then serve</span>
                    <ServeEditor
                      serve={rule.serve}
                      variantKeys={variantKeys}
                      labelPrefix={`${prefix}: `}
                      name={`rule-${rule.id}-serve`}
                      path={`rules.${i}.serve`}
                      errorFor={props.errorFor}
                      onChange={(serve) => update(i, { ...rule, serve })}
                    />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {rules.length > 0 && (
        <div className={styles.otherwise}>
          <span className={styles.ruleNode} aria-hidden="true" />
          <p>
            <span className={styles.keyword}>Otherwise</span> visitors who match no rule get the
            default behaviour (section 04).
          </p>
        </div>
      )}
      <button
        type="button"
        className={ui.textBtn}
        disabled={full}
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
        <PlusIcon size={14} />
        Add rule
      </button>
      {full && <p className={styles.hint}>A flag can have up to {LIMITS.rulesPerFlag} rules.</p>}
    </div>
  );
}
