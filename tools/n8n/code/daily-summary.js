// n8n Code node "Summarize rollouts" in workflows/daily-rollout-summary.json (ADR 0040).
// The workflow holds an exact copy of this file; code.test.mjs fails if they differ.
// Input: the HTTP Request node's item, GET /v1/flags ({ flags }). Output: { content }.
// Mirrors eval-core's describeRollout; a property test checks the two agree.

/** Discord refuses longer messages. */
const DISCORD_LIMIT = 2000;

/** Weights are basis points: 2500 is 25%. */
function shares(serve) {
  if (serve.variant !== undefined) return [{ variant: serve.variant, percent: 100 }];
  return serve.rollout.map((r) => ({ variant: r.variant, percent: r.weight / 100 }));
}

const sharesText = (list) =>
  list.length === 0 ? 'nothing' : list.map((s) => `${s.variant} ${s.percent}%`).join(', ');

/** Some users get one variant and some another. */
const isSplit = (list) => list.some((s) => s.percent > 0 && s.percent < 100);

/** "rule beta: on 100% · everyone else: on 25%, off 75%", for a flag that is on. */
function describe(flag) {
  return [
    ...flag.rules.map((r) => `rule ${r.id}: ${sharesText(shares(r.serve))}`),
    `${flag.rules.length ? 'everyone else' : 'everyone'}: ${sharesText(shares(flag.defaultServe))}`,
  ].join(' · ');
}

/** On, and splitting users somewhere: a rollout (or experiment) in progress. */
function activeRollouts(flags) {
  return flags.filter(
    (f) =>
      f.enabled && [f.defaultServe, ...f.rules.map((r) => r.serve)].some((s) => isSplit(shares(s))),
  );
}

function summarize(flags, date) {
  const active = activeRollouts(flags);
  if (active.length === 0) return `📊 Rollouts on ${date}: none in progress.`;
  const text = [
    `📊 **Rollouts in progress** (${date})`,
    ...active.map((f) => `• \`${f.key}\`: ${describe(f)}`),
  ].join('\n');
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}

if (typeof $input !== 'undefined') {
  const { flags } = $input.first().json;
  return [{ json: { content: summarize(flags, new Date().toISOString().slice(0, 10)) } }];
}
