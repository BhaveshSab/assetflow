/**
 * The load test of the AssetFlow API.
 *
 *   k6 run infra/scripts/k6-load.js
 *   k6 run -e BASE_URL=https://<host> -e VUS=50 -e DURATION=5m infra/scripts/k6-load.js
 *
 * The result is written to docs/results/ — the p95 from this file is the
 * number that sizes the instance (see docs/COSTS.md).
 *
 * The script logs in once per virtual user and then reads the asset list —
 * the read path is what a real dashboard produces.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';
const EMAIL = __ENV.EMAIL || 'admin@assetflow.com';
const PASSWORD = __ENV.PASSWORD || 'password123';
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '2m';

const loginErrors = new Counter('assetflow_login_errors');
const listDuration = new Trend('assetflow_list_duration', true);

export const options = {
  scenarios: {
    dashboard: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    // A failure rate above 1 % or a p95 above one second means the
    // instance is too small — that is the point of the test.
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<1000'],
  },
};

export function setup() {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (res.status !== 200) {
    loginErrors.add(1);
    throw new Error(`the login failed: ${res.status} ${res.body}`);
  }
  return { token: res.json('token') };
}

export default function (data) {
  const headers = {
    Authorization: `Bearer ${data.token}`,
    'Content-Type': 'application/json',
  };

  const res = http.get(`${BASE_URL}/api/assets?take=20`, { headers });
  listDuration.add(res.timings.duration);

  check(res, {
    'the asset list answers 200': (r) => r.status === 200,
    'the response is JSON': (r) =>
      r.headers['Content-Type'] && r.headers['Content-Type'].includes('application/json'),
  });

  sleep(1);
}
