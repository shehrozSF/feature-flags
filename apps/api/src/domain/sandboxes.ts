// A sandbox is an anonymous project with its own keys and four seeded flags,
// created when someone opens the demo (ADR 0015, spec §9.4).
import { generateKey, randomBase62, type KeyKind } from '../keys';
import type { NewFlag, Repository } from './ports';

const SANDBOX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // ADR 0024

const onOff = [
  { key: 'on', value: true },
  { key: 'off', value: false },
];

/** The demo's flags (spec §9.4). Salts are generated per sandbox. */
export const SEED_FLAGS: Omit<NewFlag, 'salt'>[] = [
  {
    key: 'promo-banner',
    name: 'Promo banner',
    description: 'Shows the banner at the top of the demo shop.',
    enabled: true,
    variants: onOff,
    offVariant: 'off',
    rules: [],
    defaultServe: { variant: 'on' },
  },
  {
    key: 'cta-color',
    name: 'Checkout button colour',
    description: 'A/B/C test of the checkout button colour.',
    enabled: true,
    variants: [
      { key: 'blue', value: '#2563eb' },
      { key: 'green', value: '#16a34a' },
      { key: 'red', value: '#dc2626' },
    ],
    offVariant: 'blue',
    rules: [],
    defaultServe: {
      rollout: [
        { variant: 'blue', weight: 3400 },
        { variant: 'green', weight: 3300 },
        { variant: 'red', weight: 3300 },
      ],
    },
  },
  {
    key: 'pk-local-payments',
    name: 'Local payments (Pakistan)',
    description: 'Shows local payment methods to visitors from Pakistan.',
    enabled: true,
    variants: onOff,
    offVariant: 'off',
    rules: [
      {
        id: 'pakistan',
        conditions: [{ attribute: 'country', op: 'in', values: ['PK'] }],
        serve: { variant: 'on' },
      },
    ],
    defaultServe: { variant: 'off' },
  },
  {
    key: 'new-pricing',
    name: 'New pricing',
    description: 'New prices from the demo backend: all pro users, 10% of everyone else.',
    enabled: true,
    variants: onOff,
    offVariant: 'off',
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
  },
];

export class SandboxService {
  constructor(private readonly repo: Repository) {}

  async create(): Promise<{ projectId: string; keys: Record<KeyKind, string> }> {
    return this.repo.withTransaction(async (tx) => {
      const { id } = await tx.createProject({
        name: 'Sandbox',
        expiresAt: new Date(Date.now() + SANDBOX_LIFETIME_MS),
      });
      const keys = {} as Record<KeyKind, string>;
      for (const kind of ['admin', 'server', 'client'] as const) {
        const { key, secretHash, prefix } = await generateKey(kind, id);
        await tx.insertKey(id, { kind, secretHash, prefix });
        keys[kind] = key;
      }
      for (const flag of SEED_FLAGS) {
        await tx.insertFlag(id, { ...flag, salt: randomBase62(16) });
      }
      return { projectId: id, keys };
    });
  }
}
