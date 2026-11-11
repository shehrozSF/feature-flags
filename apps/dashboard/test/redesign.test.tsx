import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminApi } from '../src/api';
import { App } from '../src/App';
import { FlagEditor } from '../src/components/FlagEditor';
import { jsonKind } from '../src/components/VariantsEditor';
import { describeRule, segments, serveSentence } from '../src/messages';
import { saveSandbox } from '../src/sandbox';
import { flag, KEYS } from './fixtures';

// The redesigned dashboard: the summaries it derives, the states it shows, and the
// promises it keeps (a switch never shows a state the API hasn't confirmed).
const SANDBOX = { projectId: '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f', keys: KEYS };

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listFlags: vi.fn(() => Promise.resolve([flag({ version: 7 })])),
    getFlag: vi.fn(),
    createFlag: vi.fn(),
    updateFlag: vi.fn(),
    archiveFlag: vi.fn(),
    ...overrides,
  };
}

function renderApp(api: AdminApi, confirm: () => boolean = () => true) {
  saveSandbox(localStorage, SANDBOX);
  render(
    <App
      storage={localStorage}
      createSandbox={vi.fn()}
      makeApi={() => api}
      demoUrl="https://demo.example/"
      confirm={confirm}
    />,
  );
}

beforeEach(() => localStorage.clear());

describe('derived descriptions', () => {
  it('describes a rollout as a sentence', () => {
    expect(serveSentence({ variant: 'on' })).toBe('serve on');
    expect(
      serveSentence({
        rollout: [
          { variant: 'on', weight: 1000 },
          { variant: 'off', weight: 9000 },
        ],
      }),
    ).toBe('serve on to 10% and off to 90%');
  });

  it('describes a rule as condition → outcome', () => {
    expect(
      describeRule({
        id: 'pk',
        conditions: [{ attribute: 'country', op: 'in', values: ['PK', 'IN'] }],
        serve: { variant: 'on' },
      }),
    ).toBe('country is one of PK, IN → on');
  });

  it('gives each variant the colour of its position in the flag', () => {
    const serve = {
      rollout: [
        { variant: 'red', weight: 5000 },
        { variant: 'blue', weight: 5000 },
      ],
    };
    expect(segments(serve, ['blue', 'green', 'red'])).toEqual([
      { variant: 'red', weight: 5000, colour: 3 },
      { variant: 'blue', weight: 5000, colour: 1 },
    ]);
  });

  it('names the JSON type of a variant value, or none when it is not JSON', () => {
    expect(jsonKind('true')).toBe('Boolean');
    expect(jsonKind('"blue"')).toBe('String');
    expect(jsonKind('19')).toBe('Number');
    expect(jsonKind('[1]')).toBe('Array');
    expect(jsonKind('{"a":1}')).toBe('Object');
    expect(jsonKind('null')).toBe('Null');
    expect(jsonKind('blue')).toBeNull();
  });
});

describe('flag list states', () => {
  it('keeps the switch on its saved state while a save is pending', async () => {
    let finish: (value: Awaited<ReturnType<AdminApi['updateFlag']>>) => void = () => {};
    const updateFlag = vi.fn(() => new Promise<never>((resolve) => (finish = resolve as never)));
    renderApp(fakeApi({ updateFlag }));

    const toggle = await screen.findByRole('switch', { name: /promo banner/i });
    await userEvent.click(toggle);

    // Not flipped yet: the API hasn't confirmed anything.
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toBeDisabled();
    const row = toggle.closest('li')!;
    expect(within(row).getByText(/saving/i)).toBeInTheDocument();

    finish({ value: flag({ enabled: false, version: 8 }), propagation: 'ok' });
    await vi.waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
    expect(within(row).queryByText(/saving/i)).not.toBeInTheDocument();
  });

  it('shows a failed save beside the switch, and the alert says why', async () => {
    const updateFlag = vi.fn(() =>
      Promise.reject(new ApiError({ kind: 'network', message: 'offline' })),
    );
    renderApp(fakeApi({ updateFlag }));
    const toggle = await screen.findByRole('switch', { name: /promo banner/i });
    await userEvent.click(toggle);

    expect(await within(toggle.closest('li')!).findByText(/not saved/i)).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-checked', 'true'); // still the truth
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't reach/i);
  });

  it('a failed load can be retried', async () => {
    const listFlags = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ kind: 'unavailable', retryAfterMs: 5000 }))
      .mockResolvedValueOnce([flag()]);
    renderApp(fakeApi({ listFlags }));

    await userEvent.click(await screen.findByRole('button', { name: /try again/i }));
    expect(await screen.findByText('Promo banner')).toBeInTheDocument();
    expect(listFlags).toHaveBeenCalledTimes(2);
  });

  it('an expired sandbox is explained, with a way to start over', async () => {
    const confirm = vi.fn(() => true);
    renderApp(
      fakeApi({ listFlags: vi.fn(() => Promise.reject(new ApiError({ kind: 'unauthorized' }))) }),
      confirm,
    );
    expect(await screen.findByText(/this sandbox has expired/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new flag/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /start a new sandbox/i }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create my sandbox/i })).toBeInTheDocument();
  });

  it('an empty sandbox says so and offers to create a flag', async () => {
    renderApp(fakeApi({ listFlags: vi.fn(() => Promise.resolve([])) }));
    expect(await screen.findByText(/no flags in this sandbox/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /create a flag/i }));
    expect(screen.getByRole('form', { name: /new flag/i })).toBeInTheDocument();
  });

  it('a disabled flag says what everyone gets, apart from its rollout', async () => {
    renderApp(
      fakeApi({
        listFlags: vi.fn(() =>
          Promise.resolve([
            flag({
              enabled: false,
              defaultServe: {
                rollout: [
                  { variant: 'on', weight: 1000 },
                  { variant: 'off', weight: 9000 },
                ],
              },
            }),
          ]),
        ),
      }),
    );
    const row = (await screen.findByText('Promo banner')).closest('li')!;
    expect(within(row).getByText('Everyone gets off')).toBeInTheDocument();
    expect(within(row).getByText(/when on: on 10% · off 90%/i)).toBeInTheDocument();
  });

  it('many flags can be filtered by name or key', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      flag({ key: `flag-${i}`, name: `Feature ${i}`, description: '' }),
    );
    renderApp(fakeApi({ listFlags: vi.fn(() => Promise.resolve(many)) }));
    await userEvent.type(await screen.findByLabelText(/filter flags/i), 'flag-3');
    expect(screen.getByText('Feature 3')).toBeInTheDocument();
    expect(screen.queryByText('Feature 4')).not.toBeInTheDocument();
  });
});

describe('flag editor extras', () => {
  const pricing = flag({
    key: 'new-pricing',
    name: 'New pricing',
    rules: [
      {
        id: 'pro-plan',
        conditions: [{ attribute: 'plan', op: 'eq', values: ['pro'] }],
        serve: { variant: 'on' },
      },
    ],
    defaultServe: {
      rollout: [
        { variant: 'on', weight: 1000 },
        { variant: 'off', weight: 9000 },
      ],
    },
    version: 3,
  });

  const renderEditor = (api: AdminApi = fakeApi()) =>
    render(
      <FlagEditor
        api={api}
        flag={pricing}
        onSaved={vi.fn()}
        onArchived={vi.fn()}
        onClose={vi.fn()}
        confirm={() => true}
      />,
    );

  it('summarises the draft in plain words, and marks unsaved changes', async () => {
    renderEditor();
    const summary = screen.getByRole('complementary', { name: /draft summary/i });
    expect(summary).toHaveTextContent(/evaluate 1 rule in order/i);
    expect(summary).toHaveTextContent(/serve on to 10% and off to 90%/i);
    expect(summary).toHaveTextContent(/when disabled\s*serve off/i);
    expect(within(summary).getByText('Matches saved')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: /enabled/i }));
    expect(within(summary).getByText('Unsaved changes')).toBeInTheDocument();
    expect(summary).toHaveTextContent(/saved: on/i);
  });

  it('shows the key as unchangeable and the variant types', () => {
    renderEditor();
    expect(screen.getByText('new-pricing')).toBeInTheDocument();
    expect(screen.getByText(/the key can't change/i)).toBeInTheDocument();
    expect(screen.getAllByText('Boolean')).toHaveLength(2);
  });

  it('flags a variant value that is not JSON', async () => {
    renderEditor();
    const value = screen.getByLabelText('Variant 1 value');
    await userEvent.clear(value);
    await userEvent.type(value, 'yes');
    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
    expect(value).toHaveAccessibleDescription(/enter a JSON value/i);
  });

  it('a conflict compares the two versions field by field', async () => {
    const theirs = { ...pricing, name: 'Pricing v2', enabled: false, version: 9 };
    const updateFlag = vi.fn(() =>
      Promise.reject(new ApiError({ kind: 'conflict', current: theirs })),
    );
    renderEditor(fakeApi({ updateFlag }));
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));

    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: /latest saved/i })).toHaveTextContent(
      /version 9/,
    );
    const changed = within(table)
      .getAllByRole('row')
      .filter((row) => row.getAttribute('data-changed') === 'true')
      .map((row) => within(row).getByRole('rowheader').textContent);
    expect(changed).toEqual(['NameChanged', 'StateChanged']);
    // Both ways forward are explained.
    expect(screen.getByRole('button', { name: /use theirs/i })).toHaveAccessibleDescription(
      /draft is discarded/i,
    );
    expect(screen.getByRole('button', { name: /apply mine on top/i })).toHaveAccessibleDescription(
      /over version 9/i,
    );
  });
});
