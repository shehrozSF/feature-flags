// Tells "Postgres can't be reached right now" apart from every other error.
// The first is an outage worth retrying (503 + Retry-After); anything else is a
// bug or a bad request, and stays a 500 so it gets noticed.

/** Network failures Node reports while connecting to, or talking to, the database. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Postgres SQLSTATEs meaning the server can't take this connection:
 * class 08 = connection exceptions; 57P01–57P03 = shutting down, crashed,
 * still starting up; 53300 = too many connections.
 */
const SERVER_CODES = /^(08...|57P0[123]|53300)$/;

/** pg and pg-pool raise these without a code. */
const MESSAGES = /^(Connection terminated|timeout exceeded when trying to connect)/;

export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // Node tries each address of a host (IPv6, IPv4) and wraps all the failures.
  if (error instanceof AggregateError) return error.errors.some(isConnectionError);
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (NETWORK_CODES.has(code) || SERVER_CODES.test(code))) {
    return true;
  }
  return MESSAGES.test(error.message);
}
