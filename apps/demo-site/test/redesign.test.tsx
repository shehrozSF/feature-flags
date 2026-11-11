import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { FakeClient } from './fake-client';

// The redesigned shop: product imagery, honest status wording, and preview
// controls kept apart from the shop itself.
const renderShop = (client: FakeClient, priceSource?: Parameters<typeof App>[0]['priceSource']) =>
  render(<App client={client} dashboardUrl="https://dash.example/" priceSource={priceSource} />);

describe('demo shop presentation', () => {
  it('shows the product photo with a description', () => {
    renderShop(new FakeClient());
    expect(screen.getByRole('img', { name: /everyday backpack in olive/i })).toBeInTheDocument();
  });

  it('says "Live updates" without promising a time', () => {
    renderShop(new FakeClient());
    expect(screen.getByRole('status')).toHaveTextContent(/^\s*Live updates$/);
  });

  it('lists each local wallet as its own badge', () => {
    renderShop(new FakeClient({ 'pk-local-payments': true }));
    const payments = screen.getByRole('region', { name: /local payments/i });
    const wallets = within(payments)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(wallets).toEqual(['JazzCash', 'Easypaisa']);
  });

  it('keeps the preview controls in their own labelled panel and shows the visitor', async () => {
    const client = new FakeClient();
    renderShop(client);
    const panel = screen.getByRole('complementary', { name: /preview controls/i });
    expect(within(panel).getByText(/anonymous · United States · free/)).toBeInTheDocument();

    await userEvent.type(within(panel).getByLabelText(/user id/i), 'u7');
    await userEvent.selectOptions(within(panel).getByLabelText(/country/i), 'PK');
    await userEvent.click(within(panel).getByRole('button', { name: /act as this user/i }));
    expect(within(panel).getByText(/u7 · Pakistan · free/)).toBeInTheDocument();
  });

  it('Buy now says it is a demo and places no order', () => {
    renderShop(new FakeClient());
    expect(screen.getByRole('button', { name: /buy now/i })).toHaveAccessibleDescription(
      /no order is placed/i,
    );
  });

  it('a changed colour keeps the same button (and its focus)', () => {
    const client = new FakeClient({ 'cta-color': 'blue' });
    renderShop(client);
    const button = screen.getByRole('button', { name: /buy now/i });
    button.focus();
    act(() => client.set({ 'cta-color': 'red' }));
    expect(screen.getByRole('button', { name: /buy now/i })).toBe(button);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute('data-color', 'red');
  });

  it('the price card keeps its place while the price loads', () => {
    renderShop(
      new FakeClient(),
      vi.fn(() => new Promise<never>(() => {})),
    );
    const price = screen.getByRole('region', { name: /price/i });
    expect(price).toHaveAttribute('data-state', 'loading');
    expect(price).toHaveTextContent(/loading the price/i);
  });
});
