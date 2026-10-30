// Tests for the benchmark tooling. They run the real scripts as child processes
// against small fake result folders, the same way CI uses them.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = import.meta.dirname;
const run = (script, ...args) =>
  spawnSync(process.execPath, [join(here, script), ...args], { encoding: 'utf8' });

/** Writes { name: hz } as Vitest-style result files into a new temp folder. */
function results(hzByName) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-'));
  for (const [name, hz] of Object.entries(hzByName)) {
    writeFileSync(
      join(dir, `${name}.json`),
      JSON.stringify({ throughput: { mean: hz }, latency: { p99: 0.001 } }),
    );
  }
  return dir;
}

describe('check.mjs', () => {
  it('passes when nothing got slower', () => {
    const dir = results({ a: 100, b: 200 });
    expect(run('check.mjs', dir, dir).status).toBe(0);
  });

  it('fails when a benchmark drops more than the threshold', () => {
    const r = run('check.mjs', results({ a: 100 }), results({ a: 60 }), '--threshold', '0.30');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('regression');
  });

  it('works without --threshold (first argument is not dropped)', () => {
    expect(run('check.mjs', results({ a: 100 }), results({ a: 100 })).status).toBe(0);
  });

  it('reports benchmarks missing from base as new, without failing', () => {
    const r = run('check.mjs', join(tmpdir(), 'does-not-exist'), results({ a: 100 }));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('new');
  });

  it('fails when the head folder has no results', () => {
    const r = run('check.mjs', results({ a: 100 }), results({}));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no benchmark results');
  });

  it('lists benchmarks that disappeared from head', () => {
    const r = run('check.mjs', results({ a: 100, gone: 100 }), results({ a: 100 }));
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/gone.*removed/);
  });
});

describe('median.mjs', () => {
  it('copies, per benchmark, the run with the median throughput', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'median-')), 'out');
    mkdirSync(out);
    const runs = [
      results({ a: 300, b: 10 }),
      results({ a: 100, b: 30 }),
      results({ a: 200, b: 20 }),
    ];
    expect(run('median.mjs', out, ...runs).status).toBe(0);
    const hz = (name) =>
      JSON.parse(readFileSync(join(out, `${name}.json`), 'utf8')).throughput.mean;
    expect(hz('a')).toBe(200);
    expect(hz('b')).toBe(20);
  });
});
