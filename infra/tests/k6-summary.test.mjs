import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { formatLoadSummary, SUMMARY_TREND_STATS } from '../scripts/lib/k6-summary.js';

const config = { tag: 'ci', vus: 5, duration: '45s', summaryFile: 'summary.txt' };
const metrics = {
  http_req_duration: { values: { med: 8.8, 'p(95)': 19.4, 'p(99)': 45.6, max: 471.6 } },
  http_reqs: { values: { rate: 5.01, count: 231 } },
  iterations: { values: { count: 225 } },
  http_req_failed: { values: { rate: 0 } },
  checks: { values: { rate: 1 } },
  assetflow_response_bytes: { values: { avg: 9436 } },
};

test('the k6 options explicitly request the p99 statistic', () => {
  assert.ok(SUMMARY_TREND_STATS.includes('p(99)'));
  const script = readFileSync(new URL('../scripts/k6-load.js', import.meta.url), 'utf8');
  assert.match(script, /summaryTrendStats:\s*SUMMARY_TREND_STATS/);
});

test('measured percentiles, rates and counts are reported without index mixups', () => {
  const result = formatLoadSummary({ metrics }, config);
  for (const line of ['p50_ms=8.8', 'p95_ms=19.4', 'p99_ms=45.6', 'requests=231', 'rps=5.01', 'checks_rate=1.0000', 'error_rate=0.00000']) {
    assert.ok(result['summary.txt'].split('\n').includes(line), line);
  }
  assert.match(result.stdout, /p95 19.4 ms · errors 0.00 %/);
});

test('a missing p99 is NA rather than a fabricated zero', () => {
  const input = structuredClone(metrics);
  delete input.http_req_duration.values['p(99)'];
  assert.match(formatLoadSummary({ metrics: input }, config)['summary.txt'], /p99_ms=NA\n/);
});

test('missing measurements and non-finite values remain unavailable', () => {
  const result = formatLoadSummary({ metrics: { http_req_duration: { values: { 'p(99)': Infinity } } } }, config);
  for (const field of ['p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'error_rate', 'checks_rate', 'rps', 'requests']) {
    assert.ok(result['summary.txt'].includes(`${field}=NA\n`), field);
  }
  assert.match(result['summary.txt'], /login_errors=0\n/);
  assert.match(result['summary.txt'], /throttled_429=0\n/);
});

test('real zero measurements are preserved, not treated as missing', () => {
  const input = structuredClone(metrics);
  input.http_req_duration.values['p(99)'] = 0;
  assert.match(formatLoadSummary({ metrics: input }, config)['summary.txt'], /p99_ms=0.0\n/);
});

test('summary file output is optional', () => {
  assert.deepEqual(Object.keys(formatLoadSummary({ metrics }, { ...config, summaryFile: '' })), ['stdout']);
});
