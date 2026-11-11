import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
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

  it('shows saved values with a notice when the API is unreachable', () => {
    const client = new FakeClient({ 'promo-banner': true });
    renderShop(client);
    expect(screen.getByRole('status')).toHaveTextContent(/live/i);

    act(() => client.setStatus('offline'));
    expect(screen.getByRole('status')).toHaveTextContent(/offline.*saved/i);
    expect(screen.getByRole('region', { name: /promotion/i })).toBeInTheDocument(); // still shown
  });
});
