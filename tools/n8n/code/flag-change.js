// n8n Code node "Verify and format" in workflows/flag-change-to-discord.json (ADR 0040).
// The workflow holds an exact copy of this file; code.test.mjs fails if they differ.
// Input: the Webhook node's item ({ headers, body }). Output: one item,
// { valid: true, content } for Discord, or { valid: false, reason }.
const crypto = require('crypto');

/** Signatures older or newer than this are refused, so a captured request can't be replayed later. */
const MAX_SKEW_SECONDS = 300;
/** Discord refuses longer messages. */
const DISCORD_LIMIT = 2000;
const ICONS = { 'flag.created': '🆕', 'flag.updated': '🔁', 'flag.archived': '🗄️', ping: '🏓' };

/** Null if the request is signed with `secret`; otherwise why not. */
function verify(headers, body, secret, nowSeconds) {
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers['x-ff-signature'] || '');
  if (!match) return 'missing or malformed x-ff-signature';
  const t = Number(match[1]);
  if (Math.abs(nowSeconds - t) > MAX_SKEW_SECONDS) return 'signature timestamp is too far off';
  // The API signs JSON.stringify output, which comes back unchanged from parsing and
  // stringifying again, so the signed bytes can be rebuilt from the parsed body.
  const signed = `${t}.${JSON.stringify(body)}`;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest();
  const given = Buffer.from(match[2], 'hex');
  return crypto.timingSafeEqual(expected, given) ? null : 'signature does not match';
}

/** One Discord line from the event's own summary. */
function format(event) {
  const via = event.source === 'mcp' ? ' (via MCP)' : '';
  const text = `${ICONS[event.type] || '🚩'} ${event.summary}${via}`;
  return text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text;
}

if (typeof $input !== 'undefined') {
  const { headers, body } = $input.first().json;
  const secret = $env.FF_WEBHOOK_SECRET;
  const now = Math.floor(Date.now() / 1000);
  const reason = secret ? verify(headers, body, secret, now) : 'FF_WEBHOOK_SECRET is not set';
  return [{ json: reason ? { valid: false, reason } : { valid: true, content: format(body) } }];
}
