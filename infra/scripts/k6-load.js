/**
 * The load test of the AssetFlow API.
 *
 *   k6 run infra/scripts/k6-load.js                         # one stage, 10 VUs
 *   k6 run -e VUS=50 -e DURATION=2m infra/scripts/k6-load.js
 *
 * `infra/scripts/load-test.sh` drives the whole ramp and writes the report;
 * this file is the part that talks to the API. Run it directly when you want
 * one stage only.
 *
 * The path under test is the one a dashboard really hits: sign in once per
 * virtual user, then read the asset list (`GET /api/assets?take=20`).
 *
 * Two things make the numbers mean something:
 *
 *   - **Thresholds are inputs.** `P95_THRESHOLD_MS` and `ERROR_RATE_THRESHOLD` are
 *     inputs, so the same script finds the breaking point instead of asserting
 *     a number picked in advance.
 *   - **One identity per virtual user.** The API limits a client to 300
 *     requests a minute; if every VU shares one account (or, behind a NAT, one
 *     IP) the run measures the rate limiter at once. With `LOADTEST_USERS`
 *     accounts each VU carries its own budget, exactly like real users.
 *
 * The `--single-user` mode of the driver reproduces the old behaviour on
 * purpose: it is the "before" column of the comparison.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = env('BASE_URL', 'http://localhost:4000');
const VUS = Number(env('VUS', 10));
const DURATION = env('DURATION', '2m');
/** A label for this run, so two stages cannot be confused in a report. */
const TAG = env('TAG', 'adhoc');
const P95_THRESHOLD_MS = Number(env('P95_THRESHOLD_MS', 1000));
const ERROR_RATE_THRESHOLD = Number(env('ERROR_RATE_THRESHOLD', 0.01));
/** Seconds each virtual user waits between requests (0 pushes as hard as it can). */
const SLEEP_SECONDS = Number(env('SLEEP', 1));

/** The demo account, used when no load-test fixture exists. */
const EMAIL = env('EMAIL', 'admin@assetflow.com');
const PASSWORD = env('PASSWORD', 'password123');

/** The fixture from `npm run seed:loadtest` (see load-test.sh). */
const LOADTEST_USERS = Number(env('LOADTEST_USERS', 0));
const LOADTEST_PASSWORD = env('LOADTEST_PASSWORD', '');
/** Force every VU onto account #1 — the "one client" mode, for comparison. */
const SINGLE_USER = env('SINGLE_USER', 'false') === 'true';
/** Where `handleSummary` writes the machine-readable result. */
const SUMMARY_FILE = env('SUMMARY_FILE', '');

const throttled = new Counter('assetflow_throttled_429');
const loginErrors = new Counter('assetflow_login_errors');
const listDuration = new Trend('assetflow_list_duration', true);
const payloadBytes = new Trend('assetflow_response_bytes', false);

function env(name, fallback) {
  const value = __ENV[name];
  return value === undefined || value === '' ? fallback : value;
}

/** The account a virtual user signs in with. */
function credentialsFor(vu) {
  if (LOADTEST_USERS > 0) {
    const index = SINGLE_USER ? 1 : ((Math.max(vu, 1) - 1) % LOADTEST_USERS) + 1;
    return {
      email: `loadtest-${String(index).padStart(3, '0')}@assetflow.test`,
      password: LOADTEST_PASSWORD,
    };
  }
  return { email: EMAIL, password: PASSWORD };
}

function login(credentials) {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify(credentials),
    { headers: { 'Content-Type': 'application/json' }, tags: { tag: TAG } },
  );
  if (res.status !== 200) {
    loginErrors.add(1);
    throw new Error(`the login failed: ${res.status} ${res.body}`);
  }
  return res.json('token');
}

export const options = {
  // A label on every metric, so two runs in one report cannot be mixed up.
  tags: { tag: TAG },
  scenarios: {
    dashboard: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
      tags: { tag: TAG },
    },
  },
  thresholds: {
    http_req_failed: [`rate<${ERROR_RATE_THRESHOLD}`],
    http_req_duration: [`p(95)<${P95_THRESHOLD_MS}`],
  },
};

/**
 * A smoke test: one sign-in before the load starts, so a broken deployment
 * fails in two seconds instead of after the whole stage.
 */
export function setup() {
  const credentials = credentialsFor(1);
  const token = login(credentials);
  return { token };
}

/**
 * Each virtual user has its own JS runtime, so this cache is per VU: one
 * sign-in per user, then the read path only — which is what the dashboard does.
 */
let cachedToken;

export default function () {
  if (!cachedToken) {
    cachedToken = login(credentialsFor(__VU));
  }

  const res = http.get(`${BASE_URL}/api/assets?take=20`, {
    headers: { Authorization: `Bearer ${cachedToken}` },
    tags: { tag: TAG },
  });

  if (res.status === 429) throttled.add(1);
  listDuration.add(res.timings.duration);
  payloadBytes.add(res.body ? res.body.length : 0);

  check(res, {
    'the asset list answers 200': (r) => r.status === 200,
    'the response is JSON': (r) =>
      Boolean(r.headers['Content-Type']) &&
      r.headers['Content-Type'].includes('application/json'),
  });

  sleep(SLEEP_SECONDS);
}

/**
 * The result, in the form the driver can read without a JSON parser: the
 * text summary still goes to stdout (and into the raw log), and a flat
 * `key=value` file is written for `load-test.sh`.
 */
export function handleSummary(data) {
  const metric = (name) => data.metrics[name] || {};
  const values = metric('http_req_duration').values || {};
  const failed = metric('http_req_failed').values || {};
  const requests = metric('http_reqs').values || {};
  const iterations = metric('iterations').values || {};
  const checks = metric('checks').values || {};
  const bytes = metric('assetflow_response_bytes').values || {};
  const loginFails = metric('assetflow_login_errors').values || {};
  const throttledCount = metric('assetflow_throttled_429').values || {};

  const lines = [
    `tag=${TAG}`,
    `vus=${VUS}`,
    `duration=${DURATION}`,
    `rps=${(requests.rate || 0).toFixed(2)}`,
    `requests=${requests.count || 0}`,
    `iterations=${iterations.count || 0}`,
    `p50_ms=${(values.med || 0).toFixed(1)}`,
    `p95_ms=${(values['p(95)'] || 0).toFixed(1)}`,
    `p99_ms=${(values['p(99)'] || 0).toFixed(1)}`,
    `max_ms=${(values.max || 0).toFixed(1)}`,
    `error_rate=${(failed.rate || 0).toFixed(5)}`,
    `checks_rate=${(checks.rate || 0).toFixed(4)}`,
    `avg_response_bytes=${Math.round(bytes.avg || 0)}`,
    `throttled_429=${throttledCount.count || 0}`,
    `login_errors=${loginFails.count || 0}`,
  ];

  const stdout = [
    '',
    `  ${TAG}: ${lines[3]} · p95 ${lines[7]} ms · errors ${(Number(lines[10]) * 100).toFixed(2)} %` +
      ` · 429s ${lines[13]}`,
    '',
  ].join('\n');

  const result = { stdout };
  if (SUMMARY_FILE) result[SUMMARY_FILE] = `${lines.join('\n')}\n`;
  return result;
}
