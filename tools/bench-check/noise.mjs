#!/usr/bin/env node
// A/A calibration: given several result directories from runs of the SAME code,
// report the largest relative hz change per benchmark versus the first run, and
// the threshold that follows from it (ADR 0020: max(3 × noise, 10%), rounded up to 5%).
//
// Usage: node tools/bench-check/noise.mjs <dir1> <dir2> [...dirN]
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length < 2) {
  console.error('usage: noise.mjs <dir1> <dir2> [...dirN]');
  process.exit(2);
}

const hzOf = (dir) =>
  new Map(
    readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => [
        f.slice(0, -'.json'.length),
        JSON.parse(readFileSync(join(dir, f), 'utf8')).throughput.mean,
      ]),
  );

const [first, ...rest] = dirs.map(hzOf);
const rows = ['| benchmark | max A/A change |', '|---|---:|'];
let worst = 0;
for (const [name, hz] of first) {
  const maxChange = Math.max(...rest.map((run) => Math.abs((run.get(name) ?? hz) / hz - 1)));
  worst = Math.max(worst, maxChange);
  rows.push(`| ${name} | ${(maxChange * 100).toFixed(1)}% |`);
}
const suggested = Math.ceil(Math.max(3 * worst, 0.1) * 20) / 20;

const report = [
  `### Benchmark noise over ${dirs.length} identical runs`,
  '',
  ...rows,
  '',
  `Largest change: **${(worst * 100).toFixed(1)}%** → suggested threshold **${suggested.toFixed(2)}**`,
  '',
].join('\n');
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
