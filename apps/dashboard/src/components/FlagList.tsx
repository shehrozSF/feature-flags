import { LIMITS, type FlagResource } from '@ff/contracts';
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, type AdminApi } from '../api';
import {
  DELAYED_TEXT,
  describeError,
  describeRule,
  describeServe,
  isExpired,
  ruleCount,
  segments,
} from '../messages';
import { FlagEditor } from './FlagEditor';
import {
  BranchIcon,
  ClockIcon,
  ErrorIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon,
} from './icons';
import { Notice, type NoticeValue } from './Notice';
import { RolloutBar, Swatch } from './RolloutBar';
import styles from './FlagList.module.css';
import ui from './ui.module.css';

/** Above this many flags, a filter box helps find one. */
const FILTER_FROM = 6;

/**
 * The sandbox's flags as one structured panel: what each flag is, who it targets,
 * what it serves, and an on/off switch. `intro` and `footer` frame the list, and
 * step aside while a flag is being edited, so the editor gets the whole page.
 */
export function FlagList({
  api,
  confirm,
  intro,
  footer,
  onStartOver,
}: {
  api: AdminApi;
  confirm: (message: string) => boolean;
  intro?: ReactNode;
  footer?: ReactNode;
  onStartOver?: () => void;
}) {
  const [flags, setFlags] = useState<FlagResource[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<'expired' | 'other' | null>(null);
  const [reloads, setReloads] = useState(0);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /** The switch whose last save failed: the failure is shown right beside it. */
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeValue | null>(null);
  const [filter, setFilter] = useState('');
  /** The flag being edited, 'new' for a new flag, or null for the list. */
  const [editing, setEditing] = useState<FlagResource | 'new' | null>(null);

  // Opening or closing the editor swaps the whole page: start it at the top.
  const isEditing = editing !== null;
  useEffect(() => {
    try {
      window.scrollTo({ top: 0 });
    } catch {
      // Not every environment can scroll (tests); nothing to do.
    }
  }, [isEditing]);

  useEffect(() => {
    let cancelled = false;
    api.listFlags().then(
      (loaded) => {
        if (cancelled) return;
        setFlags(loaded);
        setLoadFailed(null);
      },
      (error: unknown) => {
        if (cancelled) return;
        const expired = isExpired(error);
        setLoadFailed(expired ? 'expired' : 'other');
        setNotice({
          tone: 'error',
          text: describeError(error),
          ...(expired
            ? {}
            : {
                action: (
                  <button
                    className={`${ui.btn} ${ui.secondary} ${ui.sm}`}
                    onClick={() => {
                      setNotice(null);
                      setReloads((n) => n + 1);
                    }}
                  >
                    <RefreshIcon size={14} />
                    Try again
                  </button>
                ),
              }),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, reloads]);

  const replace = (next: FlagResource) =>
    setFlags((current) => current?.map((f) => (f.key === next.key ? next : f)) ?? null);

  const saved = (flag: FlagResource, propagation: 'ok' | 'delayed') => {
    setFlags((current) => {
      if (!current) return [flag];
      return current.some((f) => f.key === flag.key)
        ? current.map((f) => (f.key === flag.key ? flag : f))
        : [...current, flag];
    });
    setEditing(null);
    setNotice(
      propagation === 'delayed'
        ? { tone: 'warning', text: DELAYED_TEXT }
        : { tone: 'success', text: `Saved ${flag.name}.` },
    );
  };

  const archived = (key: string) => {
    setFlags((current) => current?.filter((f) => f.key !== key) ?? null);
    setEditing(null);
    setNotice({ tone: 'success', text: 'Archived. SDKs no longer see that flag.' });
  };

  if (editing) {
    return (
      <FlagEditor
        api={api}
        flag={editing === 'new' ? null : editing}
        onSaved={saved}
        onArchived={archived}
        onClose={() => setEditing(null)}
        confirm={confirm}
      />
    );
  }

  const toggle = async (flag: FlagResource) => {
    setBusyKey(flag.key);
    setFailedKey(null);
    setNotice(null);
    try {
      // The switch keeps showing the saved state until the API confirms the change.
      const saved = await api.updateFlag(flag.key, flag.version, { enabled: !flag.enabled });
      replace(saved.value);
      setNotice(
        saved.propagation === 'delayed'
          ? { tone: 'warning', text: DELAYED_TEXT }
          : {
              tone: 'success',
              text: `Saved: ${flag.name} is now ${saved.value.enabled ? 'on' : 'off'}.`,
            },
      );
    } catch (error) {
      // Someone saved first: show what they saved, so the next click starts from it.
      if (error instanceof ApiError && error.problem.kind === 'conflict') {
        replace(error.problem.current);
        setNotice({ tone: 'warning', text: describeError(error) });
      } else {
        setFailedKey(flag.key);
        setNotice({ tone: 'error', text: describeError(error) });
      }
    } finally {
      setBusyKey(null);
    }
  };

  const query = filter.trim().toLowerCase();
  const shown =
    flags && query
      ? flags.filter((f) =>
          [f.name, f.key, f.description].some((s) => s.toLowerCase().includes(query)),
        )
      : flags;

  return (
    <>
      {intro}
      <section className={styles.panel} aria-labelledby="flags-heading">
        <div className={styles.heading}>
          <div className={styles.titleGroup}>
            <h2 id="flags-heading">Flags</h2>
            {flags && (
              <span className={styles.count}>
                {flags.length} of {LIMITS.flagsPerProject}
              </span>
            )}
          </div>
          <div className={styles.tools}>
            {flags && flags.length > FILTER_FROM && (
              <label className={styles.filter}>
                <SearchIcon size={15} />
                <span className={ui.visuallyHidden}>Filter flags</span>
                <input
                  type="search"
                  placeholder="Filter by name or key"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </label>
            )}
            {loadFailed !== 'expired' && (
              <button
                className={`${ui.btn} ${ui.secondary} ${ui.sm}`}
                onClick={() => setEditing('new')}
                disabled={flags === null}
              >
                <PlusIcon size={15} />
                New flag
              </button>
            )}
          </div>
        </div>

        <div className={styles.notice}>
          <Notice notice={notice} />
        </div>

        {loadFailed === 'expired' && <Expired onStartOver={onStartOver} />}

        {flags === null && !loadFailed && <Skeleton />}

        {flags && flags.length === 0 && <Empty onCreate={() => setEditing('new')} />}

        {shown && shown.length > 0 && (
          <>
            <div className={styles.columns} aria-hidden="true">
              <span>Flag</span>
              <span>Targeting</span>
              <span>Serving</span>
              <span className={styles.stateHeading}>State</span>
            </div>
            <ul className={styles.list}>
              {shown.map((flag) => (
                <FlagRow
                  key={flag.key}
                  flag={flag}
                  busy={busyKey === flag.key}
                  failed={failedKey === flag.key}
                  onEdit={() => setEditing(flag)}
                  onToggle={() => void toggle(flag)}
                />
              ))}
            </ul>
          </>
        )}

        {flags && flags.length > 0 && shown?.length === 0 && (
          <p className={styles.noMatch}>No flags match “{filter.trim()}”.</p>
        )}
      </section>
      {footer}
    </>
  );
}

function FlagRow(props: {
  flag: FlagResource;
  busy: boolean;
  failed: boolean;
  onEdit: () => void;
  onToggle: () => void;
}) {
  const { flag, busy, failed } = props;
  const keys = flag.variants.map((v) => v.key);
  const offColour = (keys.indexOf(flag.offVariant) % 10) + 1;
  const firstRule = flag.rules[0];

  return (
    <li className={styles.row} data-enabled={flag.enabled}>
      <div className={styles.flagCell}>
        <span className={styles.name}>{flag.name}</span>
        <code className={styles.key}>{flag.key}</code>
        {flag.description && <p className={styles.description}>{flag.description}</p>}
      </div>

      <div className={styles.cell}>
        <span className={styles.cellLabel}>Targeting</span>
        {firstRule ? (
          <div className={styles.targeting}>
            <span className={`${ui.badge} ${ui.badgeAccent}`}>
              <BranchIcon size={12} />
              {ruleCount(flag.rules.length)}
            </span>
            <span className={styles.ruleText} title={flag.rules.map(describeRule).join('\n')}>
              {describeRule(firstRule)}
              {flag.rules.length > 1 && ` (+${flag.rules.length - 1} more)`}
            </span>
          </div>
        ) : (
          <span className={styles.quiet}>Everyone</span>
        )}
      </div>

      <div className={styles.cell}>
        <span className={styles.cellLabel}>Serving</span>
        {flag.enabled ? (
          <>
            <div className={styles.serveLine}>
              <RolloutBar segments={segments(flag.defaultServe, keys)} />
              <span className={styles.serveText}>{describeServe(flag.defaultServe)}</span>
            </div>
            <span className={styles.offLine}>
              {firstRule ? 'Default after rules · ' : ''}When off: {flag.offVariant}
            </span>
          </>
        ) : (
          <>
            <div className={styles.serveLine}>
              <Swatch colour={offColour} />
              <span className={styles.serveText}>Everyone gets {flag.offVariant}</span>
            </div>
            <span className={styles.offLine}>When on: {describeServe(flag.defaultServe)}</span>
          </>
        )}
      </div>

      <div className={styles.actions}>
        <button
          className={`${ui.btn} ${ui.ghost} ${ui.sm}`}
          aria-label={`Edit ${flag.name}`}
          onClick={props.onEdit}
        >
          Edit
        </button>
        <span className={styles.feedback} data-tone={failed ? 'error' : busy ? 'busy' : undefined}>
          {busy ? (
            <>
              <SpinnerIcon size={14} className={ui.spin} />
              Saving…
            </>
          ) : failed ? (
            <>
              <ErrorIcon size={14} />
              Not saved
            </>
          ) : null}
        </span>
        <button
          role="switch"
          aria-checked={flag.enabled}
          aria-label={flag.name}
          className={styles.switch}
          disabled={busy}
          aria-busy={busy || undefined}
          onClick={props.onToggle}
        >
          <span className={styles.track} aria-hidden="true">
            <span className={styles.thumb} />
          </span>
          <span className={styles.state}>{flag.enabled ? 'On' : 'Off'}</span>
        </button>
      </div>
    </li>
  );
}

/** Rows shaped like flags while the list loads, so nothing jumps when it arrives. */
function Skeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true">
      <span className={ui.visuallyHidden}>Loading flags…</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={styles.skeletonRow} aria-hidden="true">
          <span className={styles.bone} style={{ width: '42%' }} />
          <span className={styles.bone} style={{ width: '60%' }} />
          <span className={styles.bone} style={{ width: '70%' }} />
          <span className={styles.bonePill} />
        </div>
      ))}
    </div>
  );
}

function Empty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className={styles.empty}>
      <span className={styles.emptyMark} aria-hidden="true">
        <span />
      </span>
      <h3>No flags in this sandbox</h3>
      <p>
        Every flag has been archived. Create one to control something in your own app; the demo shop
        only follows its four seeded keys.
      </p>
      <button className={`${ui.btn} ${ui.primary}`} onClick={onCreate}>
        <PlusIcon size={15} />
        Create a flag
      </button>
    </div>
  );
}

function Expired({ onStartOver }: { onStartOver?: (() => void) | undefined }) {
  return (
    <div className={styles.expired}>
      <span className={styles.expiredIcon} aria-hidden="true">
        <ClockIcon size={22} />
      </span>
      <div>
        <h3>This sandbox has expired</h3>
        <p>
          Sandboxes are deleted after 30 days without dashboard use, together with their flags and
          keys. Start a new one to keep going; it comes with the four example flags.
        </p>
      </div>
      {onStartOver && (
        <button className={`${ui.btn} ${ui.primary}`} onClick={onStartOver}>
          Start a new sandbox
        </button>
      )}
    </div>
  );
}
