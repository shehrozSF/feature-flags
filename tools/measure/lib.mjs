// Shared by the measurement scripts: percentiles, a one-line summary, and
// argument parsing. Kept apart from the scripts so it can be unit-tested.

/** Nearest-rank percentile: the smallest value with at least p% of samples at or below it. */
export function percentile(values, p) {
  if (values.length === 0) throw new Error('no samples to take a percentile of');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** Count, p50, p95, max and mean, in whole milliseconds. */
export function summarize(values) {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    n: values.length,
    p50: Math.round(percentile(values, 50)),
    p95: Math.round(percentile(values, 95)),
    max: Math.round(percentile(values, 100)),
    mean: Math.round(mean),
  };
}

/**
 * `<baseUrl> [--name <positive integer>]...`, where the allowed names (and their
 * defaults) are the keys of `defaults`. Anything else sets `bad` to explain why.
 */
export function parseArgs(argv, defaults) {
  const options = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      if (options.base) return { bad: `unexpected argument ${arg}` };
      options.base = arg.replace(/\/+$/, '');
      continue;
    }
    const name = arg.slice(2);
    if (!(name in defaults)) return { bad: `unknown option ${arg}` };
    const value = Number(argv[++i]);
    if (!Number.isInteger(value) || value < 1)
      return { bad: `${arg} needs a positive whole number` };
    options[name] = value;
  }
  if (!options.base) return { bad: 'missing the API base URL' };
  return options;
}

/** Prints a usage error and exits with 2, like the smoke script. */
export function usage(script, bad, flags) {
  console.error(`${bad}\nusage: node tools/measure/${script} <baseUrl> ${flags}`);
  process.exit(2);
}

/** POSTs a sandbox and returns its keys: each run measures its own, fresh project. */
export async function createSandbox(base) {
  const res = await fetch(`${base}/v1/sandboxes`, { method: 'POST' });
  if (res.status === 429) {
    throw new Error(`sandbox creation is rate limited: ${(await res.json()).detail}`);
  }
  if (res.status !== 201) throw new Error(`POST /v1/sandboxes answered ${res.status}`);
  return (await res.json()).keys;
}
