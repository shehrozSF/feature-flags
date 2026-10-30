#!/usr/bin/env node
// Compares two directories of Vitest benchmark results (one <name>.json per
// benchmark, written by `writeResult`) and fails if any benchmark got slower
// than the threshold allows. Both directories must come from the same machine:
// numbers from different machines aren't comparable (ADR 0020).
//
// Usage: node tools/bench-check/check.mjs <baseDir> <headDir> [--threshold 0.30]
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = args.indexOf('--threshold');
const threshold = flag === -1 ? 0.3 : Number(args[flag + 1]);
const positional = flag === -1 ? args : args.filter((_, i) => i !== flag && i !== flag + 1);
const [baseDir, headDir] = positional;

if (!baseDir || !headDir || !Number.isFinite(threshold)) {
  console.error('usage: check.mjs <baseDir> <headDir> [--threshold 0.30]');
  process.exit(2);
}

/** @returns {Map<string, { hz: number, p99: number }>} */
function load(dir) {
  const results = new Map();
  if (!existsSync(dir)) return results;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    results.set(file.slice(0, -'.json'.length), {
      hz: json.throughput.mean,
      p99: json.latency.p99,
    });
  }
  return results;
}

const base = load(baseDir);
const head = load(headDir);

// An empty head almost always means a wrong path or a crashed benchmark run;
// passing silently would switch the gate off without anyone noticing.
if (head.size === 0) {
  console.error(`no benchmark results found in ${headDir}`);
  process.exit(1);
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');

const rows = [
  '| benchmark | base hz | head hz | change | head p99 (ms) | |',
  '|---|---:|---:|---:|---:|---|',
];
let failed = false;

for (const [name, h] of [...head].sort(([a], [b]) => a.localeCompare(b))) {
  const b = base.get(name);
  if (!b) {
    rows.push(`| ${name} | – | ${fmt(h.hz)} | new | ${h.p99.toFixed(4)} | |`);
    continue;
  }
  const change = h.hz / b.hz - 1;
  const regressed = change < -threshold;
  failed ||= regressed;
  const pct = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
  rows.push(
    `| ${name} | ${fmt(b.hz)} | ${fmt(h.hz)} | ${pct} | ${h.p99.toFixed(4)} | ${regressed ? '❌ regression' : '✅'} |`,
  );
}

// Renamed or deleted benchmarks are reported so a rename can't hide a regression.
for (const name of [...base.keys()].filter((n) => !head.has(n)).sort()) {
  rows.push(`| ${name} | ${fmt(base.get(name).hz)} | – | removed | – | |`);
}

const report = [
  `### Benchmarks (fail below −${(threshold * 100).toFixed(0)}%)`,
  '',
  ...rows,
  '',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');

process.exit(failed ? 1 : 0);
