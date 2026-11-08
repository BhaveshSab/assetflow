/** Pure formatter shared by k6 and Node regression tests. No k6/Node APIs. */
export const SUMMARY_TREND_STATS = [
  'avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)',
];

const fixed = (value, digits) =>
  Number.isFinite(value) ? value.toFixed(digits) : 'NA';
const count = (value) => Number.isFinite(value) ? String(value) : 'NA';

export function formatLoadSummary(data, { tag, vus, duration, summaryFile }) {
  const values = (name) => data.metrics?.[name]?.values || {};
  const latency = values('http_req_duration');
  const failed = values('http_req_failed');
  const requests = values('http_reqs');
  const iterations = values('iterations');
  const checks = values('checks');
  const bytes = values('assetflow_response_bytes');
  // Error-only counters have no samples if the error never happened. They
  // legitimately mean zero; absent latency/rate measurements do not.
  const loginErrors = values('assetflow_login_errors').count ?? 0;
  const throttled = values('assetflow_throttled_429').count ?? 0;
  const lines = [
    `tag=${tag}`,
    `vus=${vus}`,
    `duration=${duration}`,
    `rps=${fixed(requests.rate, 2)}`,
    `requests=${count(requests.count)}`,
    `iterations=${count(iterations.count)}`,
    `p50_ms=${fixed(latency.med, 1)}`,
    `p95_ms=${fixed(latency['p(95)'], 1)}`,
    `p99_ms=${fixed(latency['p(99)'], 1)}`,
    `max_ms=${fixed(latency.max, 1)}`,
    `error_rate=${fixed(failed.rate, 5)}`,
    `checks_rate=${fixed(checks.rate, 4)}`,
    `avg_response_bytes=${fixed(bytes.avg, 0)}`,
    `throttled_429=${count(throttled)}`,
    `login_errors=${count(loginErrors)}`,
  ];
  const result = {
    stdout: `\n  ${tag}: ${fixed(requests.rate, 2)} req/s · p95 ${fixed(latency['p(95)'], 1)} ms · errors ${fixed(failed.rate * 100, 2)} % · 429s ${count(throttled)}\n\n`,
  };
  if (summaryFile) result[summaryFile] = `${lines.join('\n')}\n`;
  return result;
}
