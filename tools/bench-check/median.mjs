#!/usr/bin/env node
// Combines several benchmark runs into one: for each benchmark, copies the
// result file of the run with the median throughput into <outDir>. A median of
// 3 runs is far steadier than any single run (ADR 0020).
//
// Usage: node tools/bench-check/median.mjs <outDir> <runDir1> <runDir2> [...runDirN]
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [outDir, ...runDirs] = process.argv.slice(2);
if (!outDir || runDirs.length < 2) {
  console.error('usage: median.mjs <outDir> <runDir1> <runDir2> [...runDirN]');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const names = new Set(
  runDirs.flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith('.json'))),
);

for (const file of names) {
  const runs = runDirs
    .map((dir) => join(dir, file))
    .filter((path) => existsSync(path))
    .map((path) => ({ path, hz: JSON.parse(readFileSync(path, 'utf8')).throughput.mean }))
    .sort((a, b) => a.hz - b.hz);
  copyFileSync(runs[Math.floor((runs.length - 1) / 2)].path, join(outDir, file));
}
