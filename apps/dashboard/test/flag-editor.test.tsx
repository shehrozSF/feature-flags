import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminApi } from '../src/api';
import { FlagEditor } from '../src/components/FlagEditor';
import { flag } from './fixtures';

// The flag editor: change variants, rules and rollouts, and save safely when
// someone else may be editing the same flag.
const cta = flag({
  key: 'cta-color',
  name: 'CTA colour',
  variants: [
    { key: 'blue', value: 'blue' },
    { key: 'green', value: 'green' },
  ],
  offVariant: 'blue',
  defaultServe: {
    rollout: [
      { variant: 'blue', weight: 5000 },
      { variant: 'green', weight: 5000 },
    ],
  },
  version: 4,
});

function api(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listFlags: vi.fn(),
    getFlag: vi.fn(),
    createFlag: vi.fn(),
    updateFlag: vi.fn(),
    archiveFlag: vi.fn(),
    ...overrides,
  };
}

function renderEditor(options: {
  api: AdminApi;
  flag?: typeof cta | null;
  confirm?: () => boolean;
}) {
  const onSaved = vi.fn();
  const onArchived = vi.fn();
  const onClose = vi.fn();
  render(
    <FlagEditor
      api={options.api}
      flag={options.flag === undefined ? cta : options.flag}
      onSaved={onSaved}
      onArchived={onArchived}
      onClose={onClose}
      confirm={options.confirm ?? (() => true)}
    />,
  );
  return { onSaved, onArchived, onClose };
}

const setField = async (label: string | RegExp, value: string) => {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  if (value) await userEvent.type(input, value);
};
const save = () => userEvent.click(screen.getByRole('button', { name: /^save/i }));

describe('dashboard: flag editor', () => {
  it('edits a rollout and saves it', async () => {
    const updateFlag = vi.fn(() =>
      Promise.resolve({ value: { ...cta, version: 5 }, propagation: 'ok' as const }),
    );
    const { onSaved } = renderEditor({ api: api({ updateFlag }) });

    await setField('blue %', '70');
    await setField('green %', '30');
    await save();

    expect(updateFlag).toHaveBeenCalledWith(
      'cta-color',
      4,
      expect.objectContaining({
        defaultServe: {
          rollout: [
            { variant: 'blue', weight: 7000 },
            { variant: 'green', weight: 3000 },
          ],
        },
      }),
    );
    expect(onSaved).toHaveBeenCalledWith({ ...cta, version: 5 }, 'ok');
  });

  it('weights must add up to 100%', async () => {
    renderEditor({ api: api() });
    await setField('blue %', '60');
    await setField('green %', '30');

    expect(screen.getByRole('button', { name: /^save/i })).toBeDisabled();
    expect(screen.getByText(/add up to 90%, they must add up to 100%/)).toBeInTheDocument();
  });

  it('422 field errors appear next to their fields', async () => {
    const updateFlag = vi.fn(() =>
      Promise.reject(
        new ApiError({
          kind: 'invalid',
          errors: [{ path: 'name', message: 'that name is taken' }],
        }),
      ),
    );
    renderEditor({ api: api({ updateFlag }) });
    await save();
    expect(await screen.findByLabelText('Name')).toHaveAccessibleDescription(/that name is taken/);
  });

  it('a stale save shows the current flag and keeps your edit', async () => {
    const theirs = { ...cta, name: 'Their colour', version: 9 };
    const updateFlag = vi
      .fn()
      .mockRejectedValueOnce(new ApiError({ kind: 'conflict', current: theirs }))
      .mockResolvedValueOnce({
        value: { ...theirs, name: 'My colour', version: 10 },
        propagation: 'ok',
      });
    const { onSaved } = renderEditor({ api: api({ updateFlag }) });

    await setField('Name', 'My colour');
    await save();

    // Both versions are visible; nothing was silently overwritten.
    expect(await screen.findByText(/someone else saved this flag/i)).toBeInTheDocument();
    expect(screen.getByText(/Their colour/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('My colour');

    await userEvent.click(screen.getByRole('button', { name: /apply mine on top/i }));
    expect(updateFlag).toHaveBeenLastCalledWith(
      'cta-color',
      9, // their version: our edit now knowingly replaces theirs
      expect.objectContaining({ name: 'My colour' }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('"use theirs" drops your edit for their version', async () => {
    const theirs = { ...cta, name: 'Their colour', version: 9 };
    const updateFlag = vi.fn(() =>
      Promise.reject(new ApiError({ kind: 'conflict', current: theirs })),
    );
    renderEditor({ api: api({ updateFlag }) });
    await setField('Name', 'My colour');
    await save();
    await userEvent.click(await screen.findByRole('button', { name: /use theirs/i }));
    expect(screen.getByLabelText('Name')).toHaveValue('Their colour');
  });

  it('creates a new flag', async () => {
    const createFlag = vi.fn((input: { key: string }) =>
      Promise.resolve({
        value: flag({ key: input.key, name: 'Checkout v2' }),
        propagation: 'ok' as const,
      }),
    );
    const { onSaved } = renderEditor({ api: api({ createFlag }), flag: null });

    await setField('Key', 'checkout-v2');
    await setField('Name', 'Checkout v2');
    await save();

    expect(createFlag).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'checkout-v2', name: 'Checkout v2', offVariant: 'off' }),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('a new flag needs a valid key before it can be saved', async () => {
    renderEditor({ api: api(), flag: null });
    await setField('Key', 'Not Valid');
    await setField('Name', 'x');
    expect(screen.getByRole('button', { name: /^save/i })).toBeDisabled();
  });

  it('archives a flag after confirming', async () => {
    const archiveFlag = vi.fn(() => Promise.resolve({ value: null, propagation: 'ok' as const }));
    let answer = false;
    const { onArchived } = renderEditor({ api: api({ archiveFlag }), confirm: () => answer });

    await userEvent.click(screen.getByRole('button', { name: /archive/i }));
    expect(archiveFlag).not.toHaveBeenCalled();

    answer = true;
    await userEvent.click(screen.getByRole('button', { name: /archive/i }));
    expect(archiveFlag).toHaveBeenCalledWith('cta-color', 4);
    expect(onArchived).toHaveBeenCalledWith('cta-color');
  });

  it('adds a targeting rule', async () => {
    const updateFlag = vi.fn(() => Promise.resolve({ value: cta, propagation: 'ok' as const }));
    renderEditor({ api: api({ updateFlag }) });

    await userEvent.click(screen.getByRole('button', { name: /add rule/i }));
    await setField('Rule 1 attribute', 'country');
    await userEvent.selectOptions(screen.getByLabelText('Rule 1 operator'), 'in');
    await setField('Rule 1 values', 'PK, IN');
    await save();

    expect(updateFlag).toHaveBeenCalledWith(
      'cta-color',
      4,
      expect.objectContaining({
        rules: [
          expect.objectContaining({
            conditions: [{ attribute: 'country', op: 'in', values: ['PK', 'IN'] }],
            serve: { variant: 'blue' },
          }),
        ],
      }),
    );
  });
});
