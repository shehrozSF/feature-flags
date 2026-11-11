// The sandbox keys this demo uses. The dashboard's "Open the demo site" link puts
// them in the URL fragment (#client=…&server=…), which browsers never send to a
// server; we keep them in localStorage and remove them from the address bar so
// they aren't bookmarked or shared by accident (ADR 0030).
export type DemoKeys = { client: string; server: string };

const STORAGE_KEY = 'ff:demo:keys';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const keyPattern = (kind: 'client' | 'server') =>
  new RegExp(`^ff_${kind}_${UUID}_[0-9A-Za-z]{43}$`);

function isKeys(value: unknown): value is DemoKeys {
  if (typeof value !== 'object' || value === null) return false;
  const { client, server } = value as Record<string, unknown>;
  return (
    typeof client === 'string' &&
    typeof server === 'string' &&
    keyPattern('client').test(client) &&
    keyPattern('server').test(server)
  );
}

export function takeKeysFromUrl(
  location: Pick<Location, 'hash' | 'pathname' | 'search'>,
  history: Pick<History, 'replaceState'>,
  storage: Storage | null,
): DemoKeys | null {
  const params = new URLSearchParams(location.hash.slice(1));
  const fromUrl = { client: params.get('client'), server: params.get('server') };
  if (isKeys(fromUrl)) {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(fromUrl));
    } catch {
      // No storage: the keys still work for this visit.
    }
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return fromUrl;
  }
  try {
    const stored: unknown = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    return isKeys(stored) ? stored : null;
  } catch {
    return null;
  }
}
