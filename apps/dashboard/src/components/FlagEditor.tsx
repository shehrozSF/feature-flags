import type { FieldError, FlagResource } from '@ff/contracts';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { ApiError, type AdminApi } from '../api';
import { emptyDraft, problems, toDraft, toInput, toPatch, type Draft } from '../draft';
import {
  describeError,
  describeRule,
  describeServe,
  ruleCount,
  segments,
  serveSentence,
} from '../messages';
import { Field } from './Field';
import { ArrowLeftIcon, LockIcon, WarningIcon } from './icons';
import { Notice, type NoticeValue } from './Notice';
import { RolloutBar, Swatch } from './RolloutBar';
import { RulesEditor } from './RulesEditor';
import { ServeEditor } from './ServeEditor';
import { VariantsEditor } from './VariantsEditor';
import styles from './editor.module.css';
import ui from './ui.module.css';

/**
 * Edit a flag (or create one, when `flag` is null). Saves with the version it
 * started from (If-Match), so two tabs can't silently overwrite each other: on a
 * 409 both versions are shown and the person decides (spec §3.2, ADR 0009).
 */
export function FlagEditor(props: {
  api: AdminApi;
  flag: FlagResource | null;
  onSaved: (flag: FlagResource, propagation: 'ok' | 'delayed') => void;
  onArchived: (key: string) => void;
  onClose: () => void;
  confirm: (message: string) => boolean;
}) {
  const isNew = props.flag === null;
  const [base, setBase] = useState<FlagResource | null>(props.flag);
  const [draft, setDraft] = useState<Draft>(() =>
    props.flag ? toDraft(props.flag) : emptyDraft(),
  );
  const [serverErrors, setServerErrors] = useState<FieldError[]>([]);
  const [conflict, setConflict] = useState<FlagResource | null>(null);
  const [notice, setNotice] = useState<NoticeValue | null>(null);
  const [busy, setBusy] = useState(false);

  const found = useMemo(() => problems(draft, { isNew }), [draft, isNew]);
  const errorFor = (path: string) =>
    serverErrors.find((e) => e.path === path)?.message ??
    found.find((p) => p.path === path)?.message;
  const variantKeys = draft.variants.map((v) => v.key);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(base ? toDraft(base) : emptyDraft()),
    [draft, base],
  );

  const save = async (against: FlagResource | null) => {
    setBusy(true);
    setServerErrors([]);
    setNotice(null);
    try {
      const saved =
        isNew || !against
          ? await props.api.createFlag(toInput(draft))
          : await props.api.updateFlag(draft.key, against.version, toPatch(draft));
      props.onSaved(saved.value, saved.propagation);
    } catch (error) {
      if (error instanceof ApiError && error.problem.kind === 'conflict') {
        setConflict(error.problem.current);
      } else if (error instanceof ApiError && error.problem.kind === 'invalid') {
        setServerErrors(error.problem.errors);
        setNotice({ tone: 'error', text: 'The API rejected some fields; see the messages below.' });
      } else {
        setNotice({ tone: 'error', text: describeError(error) });
      }
    } finally {
      setBusy(false);
    }
  };

  const takeTheirs = (theirs: FlagResource) => {
    setDraft(toDraft(theirs));
    setBase(theirs);
    setConflict(null);
  };

  const applyMineOnTop = (theirs: FlagResource) => {
    setBase(theirs);
    setConflict(null);
    void save(theirs);
  };

  const archive = async () => {
    if (!base || !props.confirm(`Archive "${base.name}"? SDKs will stop seeing it.`)) return;
    setBusy(true);
    try {
      await props.api.archiveFlag(base.key, base.version);
      props.onArchived(base.key);
    } catch (error) {
      if (error instanceof ApiError && error.problem.kind === 'conflict') {
        setConflict(error.problem.current); // decide with their version in view
      } else {
        setNotice({ tone: 'error', text: describeError(error) });
      }
      setBusy(false);
    }
  };

  return (
    <form
      className={styles.editor}
      aria-label={isNew ? 'New flag' : `Edit ${base?.name ?? draft.key}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save(base);
      }}
    >
      <div className={styles.topline}>
        <button type="button" className={styles.back} onClick={props.onClose}>
          <ArrowLeftIcon size={15} />
          Back to flags
        </button>
      </div>

      <header className={styles.header}>
        <p className={styles.eyebrow}>{isNew ? 'Create a flag' : 'Edit flag'}</p>
        <h2 className={styles.heading}>{isNew ? 'New flag' : base?.name}</h2>
        {!isNew && base && (
          <div className={styles.identity}>
            <code className={styles.keyChip}>{base.key}</code>
            <span className={styles.meta}>
              <LockIcon size={13} />
              The key can't change
            </span>
            <span className={styles.meta}>Saved version {base.version}</span>
          </div>
        )}
      </header>

      {conflict && (
        <ConflictPanel
          draft={draft}
          theirs={conflict}
          onUseTheirs={() => takeTheirs(conflict)}
          onApplyMine={() => applyMineOnTop(conflict)}
        />
      )}

      <div className={styles.layout}>
        <div className={styles.sections}>
          <Section n={1} title="Details" description="How people recognise this flag.">
            {isNew && (
              <Field
                label="Key"
                error={errorFor('key')}
                hint="How code asks for this flag. Lowercase letters, digits and dashes; it can't change later."
              >
                {(control) => (
                  <input
                    {...control}
                    className={styles.mono}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="checkout-v2"
                    value={draft.key}
                    onChange={(e) => set({ key: e.target.value })}
                  />
                )}
              </Field>
            )}
            <Field label="Name" error={errorFor('name')}>
              {(control) => (
                <input
                  {...control}
                  value={draft.name}
                  onChange={(e) => set({ name: e.target.value })}
                />
              )}
            </Field>
            <Field label="Description" error={errorFor('description')}>
              {(control) => (
                <textarea
                  {...control}
                  rows={2}
                  value={draft.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              )}
            </Field>
          </Section>

          <Section
            n={2}
            title="Variants"
            description="The values this flag can serve. Each one keeps its colour across the editor."
          >
            <VariantsEditor
              variants={draft.variants}
              errorFor={errorFor}
              onChange={(variants) => set({ variants })}
            />
          </Section>

          <Section
            n={3}
            title="Targeting"
            description="Rules are checked from top to bottom, while the flag is on."
            aside={
              <span className={`${ui.badge} ${ui.badgeAccent}`}>First matching rule wins</span>
            }
          >
            <RulesEditor
              rules={draft.rules}
              variantKeys={variantKeys}
              errorFor={errorFor}
              onChange={(rules) => set({ rules })}
            />
          </Section>

          <Section n={4} title="Default behaviour" description="What everyone else gets.">
            <EnabledToggle checked={draft.enabled} onChange={(enabled) => set({ enabled })} />

            <fieldset className={styles.plainGroup}>
              <legend className={styles.label}>Everyone else gets</legend>
              <p className={styles.hint}>When the flag is on and no rule matches.</p>
              <ServeEditor
                serve={draft.defaultServe}
                variantKeys={variantKeys}
                labelPrefix=""
                name="default-serve"
                path="defaultServe"
                errorFor={errorFor}
                onChange={(defaultServe) => set({ defaultServe })}
              />
            </fieldset>

            <Field
              label="When off, serve"
              error={errorFor('offVariant')}
              hint="Everyone gets this while the flag is off."
              className={styles.variantPick}
            >
              {(control) => (
                <span className={styles.selectWrap}>
                  <Swatch colour={(variantKeys.indexOf(draft.offVariant) % 10) + 1} />
                  <select
                    {...control}
                    className={styles.mono}
                    value={draft.offVariant}
                    onChange={(e) => set({ offVariant: e.target.value })}
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
          </Section>

          {!isNew && (
            <section className={styles.danger} aria-labelledby="danger-title">
              <div>
                <h3 id="danger-title">Danger zone</h3>
                <p>
                  Archiving removes the flag from SDKs: code that asks for it gets its own fallback
                  value. This can't be undone from the dashboard.
                </p>
              </div>
              <button
                type="button"
                className={`${ui.btn} ${ui.danger}`}
                disabled={busy}
                onClick={() => void archive()}
              >
                Archive
              </button>
            </section>
          )}
        </div>

        <DraftSummary draft={draft} base={base} isNew={isNew} dirty={dirty} />
      </div>

      <div className={styles.actionBar}>
        <div className={styles.actionStatus}>
          <Notice notice={notice} />
          {found.length > 0 ? (
            <p className={styles.fixHint}>
              <WarningIcon size={14} />
              Fix{' '}
              {found.length === 1
                ? 'the highlighted field'
                : `${found.length} highlighted fields`}{' '}
              to save.
            </p>
          ) : (
            <p className={styles.draftState}>
              {conflict
                ? 'Choose a version above to continue.'
                : isNew
                  ? 'Not saved yet.'
                  : dirty
                    ? 'Unsaved changes.'
                    : 'No changes since the saved version.'}
            </p>
          )}
        </div>
        <div className={styles.actionButtons}>
          <button type="button" className={`${ui.btn} ${ui.secondary}`} onClick={props.onClose}>
            Close
          </button>
          <button
            type="submit"
            className={`${ui.btn} ${ui.primary}`}
            disabled={busy || found.length > 0 || conflict !== null}
          >
            {busy ? 'Saving…' : isNew ? 'Save new flag' : 'Save changes'}
          </button>
        </div>
      </div>
    </form>
  );
}

function Section(props: {
  n: number;
  title: string;
  description: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionNo} aria-hidden="true">
          {String(props.n).padStart(2, '0')}
        </span>
        <div className={styles.sectionTitles}>
          <h3 id={id}>{props.title}</h3>
          <p>{props.description}</p>
        </div>
        {props.aside && <div className={styles.sectionAside}>{props.aside}</div>}
      </div>
      <div className={styles.sectionBody}>{props.children}</div>
    </section>
  );
}

/** The flag's on/off state in the draft: a checkbox with switch semantics. */
function EnabledToggle(props: { checked: boolean; onChange: (checked: boolean) => void }) {
  const id = useId();
  return (
    <div className={styles.toggleRow}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className={styles.toggle}
        checked={props.checked}
        aria-describedby={`${id}-hint`}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <div className={styles.toggleText}>
        <label htmlFor={id} className={styles.label}>
          Enabled{' '}
          <span className={styles.toggleState} aria-hidden="true">
            {props.checked ? 'On' : 'Off'}
          </span>
        </label>
        <p id={`${id}-hint`} className={styles.hint}>
          When off, everyone gets the off variant. Takes effect when you save.
        </p>
      </div>
    </div>
  );
}

/**
 * The draft in plain words, derived from what's on screen right now. It says
 * which parts are the draft and which are saved, so nothing reads as live before
 * it's been saved.
 */
function DraftSummary(props: {
  draft: Draft;
  base: FlagResource | null;
  isNew: boolean;
  dirty: boolean;
}) {
  const { draft, base, isNew, dirty } = props;
  const patch = useMemo(() => toPatch(draft), [draft]);
  const keys = draft.variants.map((v) => v.key);
  const rules = patch.rules.length;
  const updated = base ? formatTime(base.updatedAt) : null;

  return (
    <aside className={styles.summary} aria-labelledby="draft-summary-title">
      <div className={styles.summaryHead}>
        <h3 id="draft-summary-title">Draft summary</h3>
        <span className={`${ui.badge} ${isNew || dirty ? ui.badgeWarning : ui.badgeSuccess}`}>
          {isNew ? 'Not saved yet' : dirty ? 'Unsaved changes' : 'Matches saved'}
        </span>
      </div>

      <ol className={styles.flow}>
        <li>
          <span className={styles.flowKey}>State</span>
          <span>
            {draft.enabled ? 'On' : 'Off'}
            {base && base.enabled !== draft.enabled && (
              <span className={styles.was}> (saved: {base.enabled ? 'on' : 'off'})</span>
            )}
          </span>
        </li>
        <li>
          <span className={styles.flowKey}>When enabled</span>
          <span>
            {rules === 0
              ? 'No targeting rules.'
              : `Evaluate ${ruleCount(rules)} in order; the first match decides.`}
          </span>
        </li>
        <li>
          <span className={styles.flowKey}>Otherwise</span>
          <span className={styles.flowServe}>
            <span>{capitalise(serveSentence(patch.defaultServe))}.</span>
            <RolloutBar segments={segments(patch.defaultServe, keys)} />
          </span>
        </li>
        <li>
          <span className={styles.flowKey}>When disabled</span>
          <span>{capitalise(serveSentence({ variant: patch.offVariant }))}.</span>
        </li>
      </ol>

      {base && (
        <p className={styles.summaryMeta}>
          Saved version {base.version}
          {updated && <> · updated {updated}</>}
        </p>
      )}
    </aside>
  );
}

/**
 * "Your draft" next to "Latest saved", field by field, with changed fields marked.
 * Both ways forward keep optimistic locking: "Use theirs" starts again from their
 * version; "Apply mine on top" saves the draft against their version number.
 */
function ConflictPanel(props: {
  draft: Draft;
  theirs: FlagResource;
  onUseTheirs: () => void;
  onApplyMine: () => void;
}) {
  const { draft, theirs } = props;
  const id = useId();
  const mine = toPatch(draft);
  const variantText = (key: string, valueText: string) => `${key} = ${normaliseJson(valueText)}`;
  const rows: { label: string; mine: string; theirs: string }[] = [
    { label: 'Name', mine: mine.name, theirs: theirs.name },
    { label: 'Description', mine: mine.description || '—', theirs: theirs.description || '—' },
    { label: 'State', mine: onOff(mine.enabled), theirs: onOff(theirs.enabled) },
    {
      label: 'Variants',
      mine: draft.variants.map((v) => variantText(v.key, v.value)).join(', '),
      theirs: theirs.variants.map((v) => `${v.key} = ${JSON.stringify(v.value)}`).join(', '),
    },
    {
      label: 'Rules',
      mine: mine.rules.map(describeRule).join('; ') || 'None',
      theirs: theirs.rules.map(describeRule).join('; ') || 'None',
    },
    {
      label: 'Everyone else',
      mine: describeServe(mine.defaultServe),
      theirs: describeServe(theirs.defaultServe),
    },
    { label: 'When off', mine: mine.offVariant, theirs: theirs.offVariant },
  ];
  const changed = rows.filter((r) => r.mine !== r.theirs).length;

  return (
    <div className={styles.conflict} role="alert">
      <div className={styles.conflictHead}>
        <span className={styles.conflictIcon} aria-hidden="true">
          <WarningIcon size={20} />
        </span>
        <div>
          <p className={styles.conflictTitle}>
            Someone else saved this flag while you were editing.
          </p>
          <p className={styles.conflictText}>
            Nothing was overwritten, and your draft is kept until you choose.{' '}
            {changed === 0
              ? 'Their version has the same content as your draft.'
              : `${changed} ${changed === 1 ? 'field differs' : 'fields differ'}.`}
          </p>
        </div>
      </div>

      <div className={styles.compareWrap}>
        <table className={styles.compare}>
          <caption className={ui.visuallyHidden}>
            Your draft compared with the latest saved version
          </caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Your draft</th>
              <th scope="col">Latest saved (version {theirs.version})</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const differs = r.mine !== r.theirs;
              return (
                <tr key={r.label} data-changed={differs}>
                  <th scope="row">
                    {r.label}
                    {differs && <span className={styles.changedTag}>Changed</span>}
                  </th>
                  <td>{r.mine}</td>
                  <td>{r.theirs}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.choices}>
        <div className={styles.choice}>
          <button
            type="button"
            className={`${ui.btn} ${ui.secondary}`}
            aria-describedby={`${id}-theirs`}
            onClick={props.onUseTheirs}
          >
            Use theirs
          </button>
          <p id={`${id}-theirs`}>
            Load the latest saved version into the editor. Your draft is discarded.
          </p>
        </div>
        <div className={styles.choice}>
          <button
            type="button"
            className={`${ui.btn} ${ui.primary}`}
            aria-describedby={`${id}-mine`}
            onClick={props.onApplyMine}
          >
            Apply mine on top
          </button>
          <p id={`${id}-mine`}>
            Save your draft over version {theirs.version}. Their changes are replaced by yours.
          </p>
        </div>
      </div>
    </div>
  );
}

const onOff = (enabled: boolean) => (enabled ? 'On' : 'Off');
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function normaliseJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text));
  } catch {
    return text;
  }
}

function formatTime(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}
