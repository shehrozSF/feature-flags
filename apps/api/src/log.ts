// Structured logs (spec §9.3): one JSON object per line, so Workers Logs can
// filter and count by field. Never logged: API keys or their hashes, evaluation
// contexts, IP addresses, request bodies, query strings, error messages.
//
// Callers can't log those by accident because:
// - only the fields named in LOG_FIELDS reach the output (the type says so, and
//   the runtime copy enforces it even past a cast);
// - errors are reduced to their name, code and stack frames. Their messages can
//   hold anything (pg puts row values in some), so they never leave the process.
// AsyncLocalStorage is the one node: API allowed outside src/adapters/: workerd
// implements it too (under nodejs_compat, which this Worker already needs for pg).
// eslint-disable-next-line no-restricted-imports
import { AsyncLocalStorage } from 'node:async_hooks';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = {
  projectId?: string;
  method?: string;
  /** The route pattern ("/v1/flags/:key"), never the real path. */
  route?: string;
  status?: number;
  durationMs?: number;
  version?: number;
  count?: number;
  attempt?: number;
  /** A webhook URL's host only: its path often holds the receiver's own secret. */
  host?: string;
  /** A webhook event's type, e.g. "flag.updated". */
  eventType?: string;
  /** Logged as errorName, errorCode and errorAt only. */
  error?: unknown;
};

const LOG_FIELDS = [
  'projectId',
  'method',
  'route',
  'status',
  'durationMs',
  'version',
  'count',
  'attempt',
  'host',
  'eventType',
] as const satisfies readonly (keyof LogFields)[];

/** Workers Logs takes the level from the console method. */
const WRITE: Record<LogLevel, (line: string) => void> = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const request = new AsyncLocalStorage<{ requestId: string }>();

/** Runs `fn` so that every line it logs, also after awaits, carries this request id. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return request.run({ requestId }, fn);
}

export function log(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line: Record<string, unknown> = { level, event };
  const requestId = request.getStore()?.requestId;
  if (requestId) line.requestId = requestId;
  for (const name of LOG_FIELDS) {
    if (fields[name] !== undefined) line[name] = fields[name];
  }
  if (fields.error !== undefined) Object.assign(line, describeError(fields.error));
  WRITE[level](JSON.stringify(line));
}

const MAX_FRAMES = 3;

function describeError(error: unknown): Record<string, string> {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const out: Record<string, string> = { errorName: error.name };
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string') out.errorCode = code;
  const at = frames(error);
  if (at) out.errorAt = at;
  return out;
}

/**
 * Where it was thrown: the top stack frames, without the message. V8's stack
 * starts with "Name: message", and a message can span lines, so the frames are
 * taken only from after that header, never by guessing which lines are frames.
 */
function frames(error: Error): string | undefined {
  const header = String(error);
  const stack = error.stack;
  if (!stack?.startsWith(header)) return undefined;
  return stack
    .slice(header.length)
    .split('\n')
    .map((frame) => frame.trim())
    .filter((frame) => frame.startsWith('at '))
    .slice(0, MAX_FRAMES)
    .join(' | ');
}

/** Cloudflare's own ray id ("8f2b3c4d5e6f7a8b-LHR"); anything else is ignored. */
const RAY_ID = /^[0-9a-f]{16}(-[A-Z]{3})?$/;

/** The request id: Cloudflare's ray id when present, so logs match Cloudflare's dashboard. */
export function requestIdFor(cfRay: string | undefined): string {
  return cfRay && RAY_ID.test(cfRay) ? cfRay : crypto.randomUUID();
}
