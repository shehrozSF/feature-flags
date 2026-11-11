import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SEED_FLAGS } from '../../api/src/domain/sandboxes';
import { App } from '../src/App';
import { FOLLOW_UP_MS } from '../src/components/PriceCard';
import type { Price, Visitor } from '../src/price';
import { FakeClient } from './fake-client';

// The demo shop: each part of the page follows one seeded flag (spec §9.4).
const DASHBOARD = 'https://dash.example/feature-flags/dashboard/';
const renderShop = (client: FakeClient | null) =>
  render(<App client={client} dashboardUrl={DASHBOARD} />);

describe('demo shop', () => {
  it('without keys it explains how to start', () => {
    renderShop(null);
    expect(
      screen.getByRole('heading', { name: /open this from your dashboard/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /go to the dashboard/i })).toHaveAttribute(
      'href',
      DASHBOARD,
    );
  });

  it('the banner follows promo-banner, live', () => {
    const client = new FakeClient({ 'promo-banner': true });
    renderShop(client);
    expect(screen.getByRole('region', { name: /promotion/i })).toBeInTheDocument();

    act(() => client.set({ 'promo-banner': false })); // a `changed` message arrives
    expect(screen.queryByRole('region', { name: /promotion/i })).not.toBeInTheDocument();
  });

  it('the button colour follows cta-color, with the name as text', () => {
    renderShop(new FakeClient({ 'cta-color': 'green' }));
    const button = screen.getByRole('button', { name: /buy now/i });
    expect(button).toHaveAttribute('data-color', 'green');
    expect(screen.getByText(/button colour: green/i)).toBeInTheDocument(); // not colour alone
  });

  it('every seeded cta-color variant shows its own colour', () => {
    // The values the API really seeds (hex codes), not names made up for the test:
    // a test with invented values let a mismatch through once (issues #70).
    const seeded = SEED_FLAGS.find((f) => f.key === 'cta-color')!;
    for (const variant of seeded.variants) {
      const { unmount } = renderShop(new FakeClient({ 'cta-color': variant.value }));
      expect(screen.getByRole('button', { name: /buy now/i })).toHaveAttribute(
        'data-color',
        variant.key,
      );
      expect(screen.getByText(`Button colour: ${variant.key}`)).toBeInTheDocument();
      unmount();
    }
  });

  it('an unknown colour falls back to blue', () => {
    renderShop(new FakeClient({ 'cta-color': 'purple' }));
    expect(screen.getByRole('button', { name: /buy now/i })).toHaveAttribute('data-color', 'blue');
  });

  it('local payments appear when pk-local-payments is on', () => {
    const client = new FakeClient({ 'pk-local-payments': false });
    renderShop(client);
    expect(screen.queryByText(/JazzCash/)).not.toBeInTheDocument();
    act(() => client.set({ 'pk-local-payments': true }));
    expect(screen.getByText(/JazzCash/)).toBeInTheDocument();
  });

  it('acting as another user calls identify', async () => {
    const client = new FakeClient();
    renderShop(client);

    await userEvent.type(screen.getByLabelText(/user id/i), 'u42');
    await userEvent.selectOptions(screen.getByLabelText(/country/i), 'PK');
    await userEvent.selectOptions(screen.getByLabelText(/plan/i), 'pro');
    await userEvent.click(screen.getByRole('button', { name: /act as this user/i }));

    expect(client.identify).toHaveBeenCalledWith({ userId: 'u42', country: 'PK', plan: 'pro' });
  });

  it('an empty user id stays anonymous', async () => {
    const client = new FakeClient();
    renderShop(client);
    await userEvent.selectOptions(screen.getByLabelText(/country/i), 'US');
    await userEvent.click(screen.getByRole('button', { name: /act as this user/i }));
    expect(client.identify).toHaveBeenCalledWith({ country: 'US', plan: 'free' });
  });

  it('a change between the first render and subscribing is not missed', () => {
    // The SDK went live (and got values) after the shop first read it, but before
    // the provider subscribed: no event will come for that change.
    const client = new FakeClient({ 'promo-banner': false });
    client.setStatus('loading');
    const statusOnce = vi.spyOn(client, 'status').mockReturnValueOnce('loading');
    const on = client.on.bind(client);
    vi.spyOn(client, 'on').mockImplementation((event, listener) => {
      client.values['promo-banner'] = true;
      statusOnce.mockReturnValue('live');
      return on(event, listener);
    });
    renderShop(client);
    expect(screen.getByRole('status')).toHaveTextContent(/live/i);
    expect(screen.getByRole('region', { name: /promotion/i })).toBeInTheDocument();
  });

  it('shows saved values with a notice when the API is unreachable', () => {
    const client = new FakeClient({ 'promo-banner': true });
    renderShop(client);
    expect(screen.getByRole('status')).toHaveTextContent(/live/i);

    act(() => client.setStatus('offline'));
    expect(screen.getByRole('status')).toHaveTextContent(/offline.*saved/i);
    expect(screen.getByRole('region', { name: /promotion/i })).toBeInTheDocument(); // still shown
  });
});

describe('demo shop: price from the pricing backend', () => {
  it('the price card shows the backend price and updates after a change', async () => {
    const client = new FakeClient({ 'new-pricing': false });
    const prices = [
      { plan: 'free', price: 24, currency: 'USD', newPricing: false },
      { plan: 'free', price: 19, currency: 'USD', newPricing: true },
    ];
    const priceSource = vi.fn(() =>
      Promise.resolve(
        prices.shift() ?? { plan: 'free', price: 19, currency: 'USD', newPricing: true },
      ),
    );
    render(<App client={client} dashboardUrl={DASHBOARD} priceSource={priceSource} />);

    expect(await screen.findByText('$24')).toBeInTheDocument();
    expect(priceSource).toHaveBeenLastCalledWith({ country: 'US', plan: 'free' });

    act(() => client.set({ 'new-pricing': true })); // the flag flipped in the dashboard
    expect(await screen.findByText('$19')).toBeInTheDocument();
    expect(screen.getByText(/new pricing/i)).toBeInTheDocument();
  });

  it('acting as a pro user asks for the pro price', async () => {
    const priceSource = vi.fn(() =>
      Promise.resolve({ plan: 'pro', price: 19, currency: 'USD', newPricing: true }),
    );
    render(<App client={new FakeClient()} dashboardUrl={DASHBOARD} priceSource={priceSource} />);
    await userEvent.selectOptions(screen.getByLabelText(/plan/i), 'pro');
    await userEvent.click(screen.getByRole('button', { name: /act as this user/i }));
    await vi.waitFor(() =>
      expect(priceSource).toHaveBeenLastCalledWith({ country: 'US', plan: 'pro' }),
    );
  });

  it("after a flag change it asks again a moment later, for the backend's cache", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = new FakeClient();
      const priceSource = vi.fn(() =>
        Promise.resolve({ plan: 'free', price: 24, currency: 'USD', newPricing: false }),
      );
      render(<App client={client} dashboardUrl={DASHBOARD} priceSource={priceSource} />);
      await screen.findByText('$24');
      act(() => client.set({ 'new-pricing': true }));
      expect(priceSource).toHaveBeenCalledTimes(2);

      await act(() => vi.advanceTimersByTimeAsync(FOLLOW_UP_MS));
      expect(priceSource).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late answer for the previous visitor does not overwrite the new one', async () => {
    const answers: Record<string, (price: Price) => void> = {};
    const priceSource = vi.fn(
      (visitor: Visitor) => new Promise<Price>((resolve) => (answers[visitor.plan] = resolve)),
    );
    render(<App client={new FakeClient()} dashboardUrl={DASHBOARD} priceSource={priceSource} />);
    await userEvent.selectOptions(screen.getByLabelText(/plan/i), 'pro');
    await userEvent.click(screen.getByRole('button', { name: /act as this user/i }));

    act(() => answers.pro!({ plan: 'pro', price: 19, currency: 'USD', newPricing: true }));
    expect(await screen.findByText('$19')).toBeInTheDocument();
    // The old request answers last; act() flushes the state update it would make.
    await act(() => {
      answers.free!({ plan: 'free', price: 24, currency: 'USD', newPricing: false });
      return Promise.resolve();
    });
    expect(screen.queryByText('$24')).not.toBeInTheDocument();
  });

  it('a slow answer from before the follow-up does not overwrite it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const client = new FakeClient();
      const pending: ((price: Price) => void)[] = [];
      const priceSource = vi.fn(() => new Promise<Price>((resolve) => pending.push(resolve)));
      render(<App client={client} dashboardUrl={DASHBOARD} priceSource={priceSource} />);
      act(() => pending[0]!({ plan: 'free', price: 24, currency: 'USD', newPricing: false }));
      await screen.findByText('$24');

      act(() => client.set({ 'new-pricing': true })); // request 2: slow, still the old price
      await act(() => vi.advanceTimersByTimeAsync(FOLLOW_UP_MS)); // request 3: the follow-up
      act(() => pending[2]!({ plan: 'free', price: 19, currency: 'USD', newPricing: true }));
      expect(await screen.findByText('$19')).toBeInTheDocument();

      await act(() => {
        pending[1]!({ plan: 'free', price: 24, currency: 'USD', newPricing: false }); // arrives last
        return Promise.resolve();
      });
      expect(screen.queryByText('$24')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failing backend shows the price as unavailable, not an error page', async () => {
    const priceSource = vi.fn(() => Promise.reject(new Error('down')));
    render(<App client={new FakeClient()} dashboardUrl={DASHBOARD} priceSource={priceSource} />);
    expect(await screen.findByText(/price unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /buy now/i })).toBeInTheDocument();
  });
});
