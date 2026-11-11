import { describe, expect, it } from 'vitest';
import { isConnectionError } from '../src/repo/pg-errors';

// Which errors mean "Postgres can't be reached right now" (→ 503, try again)
// rather than "this request or our code is wrong" (→ 500).
const withCode = (code: string, message = 'boom') => Object.assign(new Error(message), { code });

describe('isConnectionError', () => {
  it.each([
    ['refused (Node)', withCode('ECONNREFUSED')],
    ['reset (Node)', withCode('ECONNRESET')],
    ['timed out (Node)', withCode('ETIMEDOUT')],
    ['broken pipe (Node)', withCode('EPIPE')],
    ['host not found (Node)', withCode('ENOTFOUND')],
    ['DNS lookup failed (Node)', withCode('EAI_AGAIN')],
    ['host unreachable (Node)', withCode('EHOSTUNREACH')],
    ['network unreachable (Node)', withCode('ENETUNREACH')],
    ['connection exception (SQLSTATE 08006)', withCode('08006')],
    ['client unable to connect (SQLSTATE 08001)', withCode('08001')],
    ['admin shutdown (SQLSTATE 57P01)', withCode('57P01')],
    ['crash shutdown (SQLSTATE 57P02)', withCode('57P02')],
    ['starting up (SQLSTATE 57P03)', withCode('57P03')],
    ['too many connections (SQLSTATE 53300)', withCode('53300')],
    ['pool connect timeout (pg-pool)', new Error('timeout exceeded when trying to connect')],
    ['connection lost mid-query (pg)', new Error('Connection terminated unexpectedly')],
    ['connect timeout (pg)', new Error('Connection terminated due to connection timeout')],
    // Node tries every address of a host (IPv6 and IPv4) and reports all failures.
    ['every address refused', new AggregateError([withCode('ECONNREFUSED')], 'connect failed')],
  ])('%s → yes', (_name, error) => {
    expect(isConnectionError(error)).toBe(true);
  });

  it.each([
    ['a unique violation (23505)', withCode('23505')],
    ['a syntax error (42601)', withCode('42601')],
    ['a serialization failure (40001)', withCode('40001')],
    ['a plain bug', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['an error that only mentions a connection', new Error('connection settings are invalid')],
    ['an aggregate of other errors', new AggregateError([withCode('23505')])],
    ['not an error at all', 'ECONNREFUSED'],
    ['nothing', undefined],
  ])('%s → no', (_name, error) => {
    expect(isConnectionError(error)).toBe(false);
  });
});
