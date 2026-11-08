# Infrastructure regression checks

## What is implemented

- **Prometheus rule tests:** `infra/prometheus/tests/alerts.test.yml` uses the
  actual production rule file, with firing and healthy/boundary inputs for all
  **15 alerts** (the original eleven plus OOM, restart loop, certificate expiry,
  and HTTPS probe failure). Rules with a `for` delay are also checked just before that delay
  expires; recovery is checked for API availability and the OOM lookback window.
  These are synthetic time-series tests, not a destructive production drill.
- **Exporter smoke test:** CI starts the exporters and Prometheus, verifies
  both scrape targets become UP, and requires Compose-labelled start-time and
  OOM metrics. It does not require the production HTTPS probe to succeed from
  the runner, and does not prove production host compatibility.
- **cAdvisor:** container metrics on the private backend network, no published
  port. OOM events alert immediately; more than two start-time changes within
  fifteen minutes alert after two minutes. Start times aggregate by Compose
  service before `changes` so container recreation does not reset the identity.
- **Blackbox exporter:** verifies public HTTPS readiness and certificate trust.
  The expiry warning starts below fourteen days; probe failure covers invalid,
  expired, untrusted certificates and other HTTP/DNS failures. Update
  `infra/prometheus/targets/https.yml` whenever the public hostname changes.
- **Alert delivery wiring:** Prometheus now has an explicit Alertmanager
  destination. This alone does not prove that Telegram credentials or delivery
  work. Credentials remain exclusively in the server environment.
- **Load regression:** CI on pull requests, main pushes, and nightly at 03:30
  UTC boots the real API with disposable Postgres 16 + Redis 7, applies all
  migrations, and seeds five ordinary employee accounts and 500 assets. k6
  runs five users for 45 seconds, with one second between iterations, against
  login and the asset list. Rate limiting remains enabled. The gate requires
  p95 < 1000 ms, HTTP failure rate < 1%, correctness checks > 99%, and more
  than 20 completed iterations. Failed checks (including malformed JSON/page
  shape) fail the job rather than merely printing a warning.
- **Deployment:** after API readiness, `deploy.sh` reconciles cAdvisor,
  blackbox, Prometheus and Alertmanager and reloads Prometheus with a bounded
  startup retry. A monitoring failure fails deployment explicitly, but does
  not roll back a healthy API or revert database migrations.

This is a small, repeatable regression gate, **not** a 20 req/s capacity test,
not a five-minute endurance test, and not a production throughput claim. The
original planning proposal's nightly committed results are replaced by GitHub
artifacts to avoid committing generated logs on every run. CI retains the flat
k6 summary and API log for fourteen days, even on failure. Download them at
GitHub → Actions → CI → run → Artifacts → `k6-regression-<commit>`.

## Reproduce the rule checks

From a checkout with Docker (or a GitHub Codespace with Docker):

```sh
docker run --rm --entrypoint promtool \
  -v "$PWD/infra/prometheus:/etc/prometheus:ro" \
  prom/prometheus:v2.54.1 check config /etc/prometheus/prometheus.yml

docker run --rm --entrypoint promtool \
  -v "$PWD/infra/prometheus:/etc/prometheus:ro" \
  prom/prometheus:v2.54.1 test rules /etc/prometheus/tests/alerts.test.yml
```

No local checkout? Open the pull request's Checks tab. The Infrastructure job
runs both commands and validates Compose. The API load regression job executes
the load gate without needing any production credentials.

## Live checks still required

Rule tests prove rule logic on the named metrics, not exporter compatibility,
network reachability or end-to-end delivery. After deployment:

1. In Prometheus Targets, confirm cAdvisor and blackbox scrapes are UP.
2. Query `container_start_time_seconds` and `container_oom_events_total` and
   confirm `container_label_com_docker_compose_service` exists. cAdvisor depends
   on host Docker/cgroup/kernel support; an UP scrape alone is insufficient.
3. Check `probe_success{job="blackbox-https"}` is 1 and the certificate expiry
   timestamp matches the served certificate. Fix an outdated domain in the
   target file, not by disabling TLS verification.
4. Confirm Prometheus lists an active Alertmanager, then send a controlled test
   alert and verify Telegram receives both firing and resolved notifications.
   Do not kill production containers to simulate this.
5. Inspect memory/CPU overhead. These two extra exporters consume resources;
   a small 1 GB host already close to its memory limit may need more capacity
   or a separate monitoring host. Limits are ceilings, not memory reservations.

Missing exporter series do not mean healthy. Target failures and unsupported
metrics must be investigated separately. See [RUNBOOK](RUNBOOK.md) for exact
inspection commands. No notification delivery or live OOM/TLS drill is claimed
solely from a passing CI run.

## CI diagnostics and measurement regression guards

The older failing CI run `42459592756` tested integration commit `33f2791`,
not the current Phase 1/main baseline. Its extra test suite expected the critical
`HostDiskFull` alert with only 90% disk usage, checked `ApiRestarting` at 10
minutes even though its second synthetic start-time change was at minute 6
and its hold period was five minutes, and its Compose file repeated the
`cadvisor` service key. Those old files are not reintroduced here. Production
alert thresholds remain unchanged.

Current regression coverage explicitly keeps `HostDiskFull` quiet at 90% and
95% usage, fires it at 96% after its one-minute hold, and checks the current
container restart alert both before and at its hold-time boundary.

- `infra/scripts/check-yaml.py` rejects duplicate mapping keys before Docker
  runs. It permits valid anchors/merge overrides. CI uses system PyYAML.
- `bash infra/scripts/check-compose.sh` checks base/local/jobs variants, retains
  the actual Docker diagnostic and exit code, and continues checking the other
  variants. A conditional capture avoids GitHub's `bash -e` exiting before the
  error can be printed. It expects an existing `infra/.env`; CI copies only the
  sample environment on its disposable runner.
- k6 explicitly requests p99 in `summaryTrendStats`. The shared summary
  formatter reports missing measurements as `NA`, never invented zero latency
  or zero error rates. Unsampled error-only counters still mean zero events.
- The staged load driver rejects missing required measurements; a nonzero
  threshold result cannot be labelled healthy merely because latency/error
  thresholds happened to pass.

Reproduce the fast diagnostic/reporting tests without contacting production:

```sh
# Requires PyYAML; CI installs python3-yaml for /usr/bin/python3.
python3 -m unittest discover -s infra/tests -p 'test_*.py' -v
python3 infra/scripts/check-yaml.py
node --test infra/tests/k6-summary.test.mjs
```

Re-run k6 to obtain a measured p99. An old artifact containing `p99_ms=0.0`
from the fallback formatter cannot be repaired into a real percentile after
those samples have been discarded. The existing CI load test remains the same
5-user, 45-second regression workload, not a maximum-capacity test.
