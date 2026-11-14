# Stage 3 launch checklist

Everything below is done except the part that needs your GitHub credentials.
Nothing has been launched. There is no fifth instance.

## What is proven

| Item | Evidence |
|---|---|
| Seed death is observable without the seed's cooperation | 62 status tests; a real process is killed and the retained snapshot reads `interrupted` with `exit_code: null`, `cause: unknown` |
| A vanished process is never reported as a timeout or an OOM | tests assert `oom` and `timeout` never appear in an interrupted snapshot |
| Unreadable liveness is `unknown`, never success or death | tests pin this |
| Status endpoint answers before the app exists | CI step, executed |
| Only redacted snapshots, never files | CI step: run-dir paths all 404, `SuperSecret123` absent |
| Images published, digest-addressed, no `latest` | publish job success; tag list has no `latest` |
| Anonymous digest pull works | CI step after `docker logout` + `rm config.json`; resolves to itself |
| Mutable tag and partial pin are refused | CI step, both guards exercised |
| Pinned mode pulls and never builds | CI step; a nonexistent digest fails at the pull with no build log |
| Full suite | 390 tests OK in a clean clone |
| Payload fits | 16,338 / 16,384 bytes raw |
| Cloud permissions | P3 `DryRunOperation`; ingress authorize/revoke `DryRunOperation` |

Green on the branch head `ab44deda62f0e17181a9d99ff838a9bc917f6389`: run
`42888092072`, 8/8 jobs, 22 capacity steps.

Pinned digests are recorded in `infra/capacity-run/image-digests.env` and
`docs/results/stage3/image-provenance.md`.

## The blocker

The launch workflow `.github/workflows/capacity-run.yml` reads 10 repository
secrets. I have no GitHub API credential, so I cannot create them, and I will
not handle their values.

Set these under **Settings → Secrets and variables → Actions → New repository
secret**. Each value already exists in your environment; copy it, do not retype.

| Secret | Where it comes from |
|---|---|
| `AWS_ACCESS_KEY_ID` | the `capacity` profile in `~/.aws/credentials` |
| `AWS_SECRET_ACCESS_KEY` | same |
| `EVIDENCE_TOKEN` | `~/.cap-stage3/trust/trust.env` |
| `TLS_CRT_B64` | `~/.cap-stage3/trust/trust.env` |
| `TLS_KEY_B64` | `~/.cap-stage3/trust/trust.env` |
| `POSTGRES_PASSWORD` | `~/.cap-stage3/app.env` |
| `REDIS_PASSWORD` | same |
| `GRAFANA_ADMIN_PASSWORD` | same |
| `JWT_SECRET` | same |
| `LOADTEST_PASSWORD` | same |

To print one at a time without exposing the others:

```
grep '^EVIDENCE_TOKEN=' ~/.cap-stage3/trust/trust.env
```

## Then launch

Actions → **Capacity run (single launch)** → *Run workflow*:

- `confirmation`: `LAUNCH-ONE`
- `launch_epoch`: leave blank (uses now)

The job discovers its own public IPv4, opens tcp/8443 from that `/32` only,
launches one t3.micro, verifies the created configuration by reading it back,
and holds the job open while the run is observed. It removes the ingress rule in
an `always()` step, and terminates that exact instance ID if it is still running
when the job ends.

## Automatic stops

- 4-hour deadline enforced in-guest by a timer that re-derives from the launch
  instant, and independently by the operator watchdog from `LaunchTime`.
- Guest `InstanceInitiatedShutdownBehavior=terminate`; root volume
  `DeleteOnTermination=true`.
- Ingress removed even if the job fails.

## Not approved and not done

No load test, no sixth attempt, no IAM change, no S3, no production change, no
hardware change, no Unlimited credits. The SG and the budget are left in place.
