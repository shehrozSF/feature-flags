import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type AdminApi } from '../src/api';
import { App } from '../src/App';
import { demoLink, loadSandbox, saveSandbox } from '../src/sandbox';
import { flag, KEYS } from './fixtures';

// Component tests: render the real components, act like a person (click, type),
// and check what a person would see, by role and accessible name. The API is faked
// at the AdminApi boundary, so the tests decide exactly what it answers.
const SANDBOX = { projectId: '3f2a6c1e-8b4d-4e7a-9c2f-1a2b3c4d5e6f', keys: KEYS };
const DEMO = 'https://demo.example/feature-flags/demo/';

const seeded = () => [
  flag({ version: 7 }), // not 1: proves the saved version comes from the row
  flag({
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
  }),
];

function fakeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    listFlags: vi.fn(() => Promise.resolve(seeded())),
    getFlag: vi.fn(),
    createFlag: vi.fn(),
    updateFlag: vi.fn(),
    archiveFlag: vi.fn(),
    ...overrides,
  };
}

function renderApp(options: { api?: AdminApi; confirm?: () => boolean } = {}) {
  const api = options.api ?? fakeApi();
  const createSandbox = vi.fn(() => Promise.resolve(SANDBOX));
  render(
    <App
      storage={localStorage}
      createSandbox={createSandbox}
      makeApi={() => api}
      demoUrl={DEMO}
      confirm={options.confirm ?? (() => true)}
    />,
  );
  return { api, createSandbox };
}

const promoSwitch = () => screen.findByRole('switch', { name: /promo banner/i });

beforeEach(() => localStorage.clear());

describe('dashboard: sandbox and flag list', () => {
  it('first visit offers to create a sandbox', () => {
    renderApp();
    expect(screen.getByRole('button', { name: /create my sandbox/i })).toBeInTheDocument();
  });

  it('creating a sandbox shows the seeded flags and remembers them', async () => {
    const { createSandbox } = renderApp();
    await userEvent.click(screen.getByRole('button', { name: /create my sandbox/i }));

    expect(await screen.findByText('Promo banner')).toBeInTheDocument();
    expect(screen.getByText('CTA colour')).toBeInTheDocument();
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(loadSandbox(localStorage)).toEqual(SANDBOX);
  });

  it('a saved sandbox loads straight into the flag list', async () => {
    saveSandbox(localStorage, SANDBOX);
    renderApp();
    expect(await screen.findByText('Promo banner')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create my sandbox/i })).not.toBeInTheDocument();
  });

  it('describes how each flag serves', async () => {
    saveSandbox(localStorage, SANDBOX);
    renderApp();
    const cta = (await screen.findByText('CTA colour')).closest('li')!;
    expect(within(cta).getByText(/blue 50% · green 50%/)).toBeInTheDocument();
  });

  it('toggling a flag saves it with the current version', async () => {
    saveSandbox(localStorage, SANDBOX);
    const updateFlag = vi.fn(() =>
      Promise.resolve({ value: flag({ enabled: false, version: 2 }), propagation: 'ok' as const }),
    );
    renderApp({ api: fakeApi({ updateFlag }) });

    const toggle = await promoSwitch();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(toggle);

    expect(updateFlag).toHaveBeenCalledWith('promo-banner', 7, { enabled: false });
    expect(await promoSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
  });

  it('a delayed propagation is mentioned', async () => {
    saveSandbox(localStorage, SANDBOX);
    const api = fakeApi({
      updateFlag: vi.fn(() =>
        Promise.resolve({
          value: flag({ enabled: false, version: 2 }),
          propagation: 'delayed' as const,
        }),
      ),
    });
    renderApp({ api });
    await userEvent.click(await promoSwitch());
    expect(await screen.findByRole('status')).toHaveTextContent(/demo will catch up/i);
  });

  it('a conflicting toggle reloads the row and says why', async () => {
    saveSandbox(localStorage, SANDBOX);
    const current = flag({ enabled: false, version: 3 });
    const api = fakeApi({
      updateFlag: vi.fn(() => Promise.reject(new ApiError({ kind: 'conflict', current }))),
    });
    renderApp({ api });
    await userEvent.click(await promoSwitch());

    expect(await promoSwitch()).toHaveAttribute('aria-checked', 'false'); // what they saved
    expect(screen.getByRole('status')).toHaveTextContent(/changed .* elsewhere/i);
  });

  it('the demo link opens the demo with this sandbox', async () => {
    saveSandbox(localStorage, SANDBOX);
    renderApp();
    const link = await screen.findByRole('link', { name: /open the demo site/i });
    expect(link).toHaveAttribute('href', demoLink(DEMO, KEYS));
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  it('start over forgets the sandbox after confirming', async () => {
    saveSandbox(localStorage, SANDBOX);
    let answer = false;
    renderApp({ confirm: () => answer });
    const startOver = await screen.findByRole('button', { name: /start over/i });

    await userEvent.click(startOver); // "Cancel"
    expect(loadSandbox(localStorage)).toEqual(SANDBOX);

    answer = true;
    await userEvent.click(startOver);
    expect(loadSandbox(localStorage)).toBeNull();
    expect(screen.getByRole('button', { name: /create my sandbox/i })).toBeInTheDocument();
  });

  it('an API error is shown, not thrown', async () => {
    saveSandbox(localStorage, SANDBOX);
    renderApp({
      api: fakeApi({
        listFlags: vi.fn(() =>
          Promise.reject(new ApiError({ kind: 'unavailable', retryAfterMs: 5000 })),
        ),
      }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/try again/i);
  });

  it('a failed sandbox creation is explained', async () => {
    render(
      <App
        storage={localStorage}
        createSandbox={() => Promise.reject(new ApiError({ kind: 'network', message: 'offline' }))}
        makeApi={() => fakeApi()}
        demoUrl={DEMO}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /create my sandbox/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't reach/i);
  });
});

describe('dashboard: list and editor together', () => {
  it('edit opens the editor, and saving updates the list', async () => {
    saveSandbox(localStorage, SANDBOX);
    const updateFlag = vi.fn(() =>
      Promise.resolve({
        value: flag({ name: 'Summer banner', version: 8 }),
        propagation: 'ok' as const,
      }),
    );
    renderApp({ api: fakeApi({ updateFlag }) });

    await userEvent.click(await screen.findByRole('button', { name: /edit promo banner/i }));
    const name = screen.getByLabelText('Name');
    await userEvent.clear(name);
    await userEvent.type(name, 'Summer banner');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Summer banner')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: /edit/i })).not.toBeInTheDocument(); // closed
    expect(screen.getByRole('status')).toHaveTextContent(/saved/i);
  });

  it('a new flag appears in the list', async () => {
    saveSandbox(localStorage, SANDBOX);
    const createFlag = vi.fn(() =>
      Promise.resolve({
        value: flag({ key: 'checkout-v2', name: 'Checkout v2', enabled: false }),
        propagation: 'ok' as const,
      }),
    );
    renderApp({ api: fakeApi({ createFlag }) });

    await userEvent.click(await screen.findByRole('button', { name: /new flag/i }));
    await userEvent.type(screen.getByLabelText('Key'), 'checkout-v2');
    await userEvent.type(screen.getByLabelText('Name'), 'Checkout v2');
    await userEvent.click(screen.getByRole('button', { name: /save new flag/i }));

    expect(await screen.findByText('Checkout v2')).toBeInTheDocument();
  });

  it('an archived flag disappears from the list', async () => {
    saveSandbox(localStorage, SANDBOX);
    const archiveFlag = vi.fn(() => Promise.resolve({ value: null, propagation: 'ok' as const }));
    renderApp({ api: fakeApi({ archiveFlag }) });

    await userEvent.click(await screen.findByRole('button', { name: /edit promo banner/i }));
    await userEvent.click(screen.getByRole('button', { name: /archive/i }));

    expect(archiveFlag).toHaveBeenCalledWith('promo-banner', 7);
    expect(screen.queryByText('Promo banner')).not.toBeInTheDocument();
  });
});
