import type { FieldError, FlagResource } from '@ff/contracts';
import { useMemo, useState } from 'react';
import { ApiError, type AdminApi } from '../api';
import { emptyDraft, problems, toDraft, toInput, toPatch, type Draft } from '../draft';
import { describeError, describeServing } from '../messages';
import { Field } from './Field';
import { Notice, type NoticeValue } from './Notice';
import { RulesEditor } from './RulesEditor';
import { ServeEditor } from './ServeEditor';
import { VariantsEditor } from './VariantsEditor';
import styles from './editor.module.css';

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
      setNotice({ tone: 'error', text: describeError(error) });
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
      <h2 className={styles.heading}>{isNew ? 'New flag' : `Edit ${base?.name}`}</h2>

      {conflict && (
        <div className={styles.conflict} role="alert">
          <p>
            <strong>Someone else saved this flag while you were editing.</strong> Their version:{' '}
            {conflict.name} ({describeServing(conflict)}, version {conflict.version}). Your edit is
            still below.
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={() => takeTheirs(conflict)}>
              Use theirs
            </button>
            <button
              type="button"
              className={styles.primary}
              onClick={() => applyMineOnTop(conflict)}
            >
              Apply mine on top
            </button>
          </div>
        </div>
      )}

      {isNew && (
        <Field label="Key" error={errorFor('key')}>
          {(control) => (
            <input
              {...control}
              className={styles.mono}
              placeholder="checkout-v2"
              value={draft.key}
              onChange={(e) => set({ key: e.target.value })}
            />
          )}
        </Field>
      )}
      <Field label="Name" error={errorFor('name')}>
        {(control) => (
          <input {...control} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
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
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />{' '}
        Enabled (when off, everyone gets the off variant)
      </label>

      <VariantsEditor
        variants={draft.variants}
        errorFor={errorFor}
        onChange={(variants) => set({ variants })}
      />

      <Field label="When off, serve" error={errorFor('offVariant')}>
        {(control) => (
          <select
            {...control}
            value={draft.offVariant}
            onChange={(e) => set({ offVariant: e.target.value })}
          >
            {variantKeys.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
      </Field>

      <RulesEditor
        rules={draft.rules}
        variantKeys={variantKeys}
        errorFor={errorFor}
        onChange={(rules) => set({ rules })}
      />

      <fieldset className={styles.group}>
        <legend>Everyone else gets</legend>
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

      <Notice notice={notice} />
      {found.length > 0 && (
        <p className={styles.muted}>
          Fix {found.length === 1 ? 'the highlighted field' : `${found.length} highlighted fields`}{' '}
          to save.
        </p>
      )}
      <div className={styles.actions}>
        <button type="submit" className={styles.primary} disabled={busy || found.length > 0}>
          {busy ? 'Saving…' : isNew ? 'Save new flag' : 'Save changes'}
        </button>
        <button type="button" className={styles.secondary} onClick={props.onClose}>
          Close
        </button>
        {!isNew && (
          <button
            type="button"
            className={styles.danger}
            disabled={busy}
            onClick={() => void archive()}
          >
            Archive
          </button>
        )}
      </div>
    </form>
  );
}
