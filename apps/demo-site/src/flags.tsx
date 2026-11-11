// React glue for the browser SDK: a provider that re-renders on every flag change,
// and hooks to read a flag or the connection status. Components never talk to the
// SDK directly, so tests can hand in a fake client.
import type { JsonValue } from '@ff/eval-core';
import type { BrowserClient, ClientStatus } from '@ff/sdk-client';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

type FlagsState = { client: BrowserClient; version: number; status: ClientStatus };

const FlagsContext = createContext<FlagsState | null>(null);

export function FlagsProvider({
  client,
  children,
}: {
  client: BrowserClient;
  children: ReactNode;
}) {
  // `version` only changes to make React re-render when the SDK says flags changed.
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState<ClientStatus>(() => client.status());

  useEffect(() => {
    const offChange = client.on('change', () => setVersion((v) => v + 1));
    const offStatus = client.on('status', () => setStatus(client.status()));
    return () => {
      offChange();
      offStatus();
    };
  }, [client]);

  const value = useMemo(() => ({ client, version, status }), [client, version, status]);
  return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}

function useFlags(): FlagsState {
  const state = useContext(FlagsContext);
  if (!state) throw new Error('useFlag must be used inside <FlagsProvider>');
  return state;
}

/** The flag's current value for this visitor; re-renders when it changes. */
export function useFlag<T extends JsonValue>(key: string, fallback: T): T {
  const { client } = useFlags(); // re-runs on every change, via the context value
  return client.variation(key, fallback);
}

export function useFlagsStatus(): ClientStatus {
  return useFlags().status;
}

export function useFlagsClient(): BrowserClient {
  return useFlags().client;
}
