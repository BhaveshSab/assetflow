# Sixth attempt: evidence-supported diagnosis

**Run** `43007413527`, commit `fcd6ddc`, instance `i-0729cceefad4720d9`.
**Verdict:** FAILED. Application readiness never observed. No Stage 3 evidence exists.

## What the retained evidence actually contains

Retained by the workflow (redacted, non-secret), timestamps UTC:

| File | Contents | Significance |
|---|---|---|
| `readiness.log` | `curl: (28) Connection timed out after 20002 milliseconds`, `http_code=000` | The only client-side readiness probe. Ran at 11:11:05, **after** shutdown began. |
| `poll.log` | 1 line: poller started, 13800 s duration | **No snapshot was ever retained.** |
| `watchdog.log` | `11:11:03 instance is terminated; watchdog exiting` | Watchdog alive until instance death, then exited normally. |
| `p3.err` | `DryRunOperation ... Request would have succeeded` | P3 genuinely accepted. |
| `instance-id.dryrun.err` | `DryRunOperation` for RunInstances | Pre-ingress dry-run genuinely accepted. |
| `authorize.err`, `instance-id.err` | empty | No ingress or launch errors. |

## Timeline

| Time (UTC) | Event |
|---|---|
| 10:54:27 | Instance launched |
| 10:54:39 | Supervisor attached; watchdog started |
| 10:55:42 | Watchdog heartbeat advancing (alive) |
| 10:55:43 | P3 accepted; status poller started |
| **11:10:45** | **Instance `shutting-down` — guest-initiated, 16m 18s after launch** |
| 11:11:03 | Watchdog observes termination and exits |
| 11:11:05 | Supervisor's *only* readiness probe: connection timed out, `http_code=000` |

## Root cause: a readiness deadlock that cannot be broken

`bootstrap-status.py:243` returns `"application_ready": False` as a **literal constant**.
The field is a deliberate design choice with the note:

> "diagnostic channel; application readiness is reported by the application, not here"

`supervise-run.sh` then waits for that field to become `"true"`:

```sh
READY=$(jq -r '.application_ready // false' "$snapshot")
if [ "$READY" = "true" ]; then ... break; fi
```

**These two facts are mutually exclusive.** The diagnostic endpoint will never report
`application_ready=true`, so the loop can only exit by hitting the deadline or by the
instance dying. It exited because the instance died.

The actual application route (`/api/health/ready`) is probed **once, after the loop**,
at which point the instance was already shutting down. Hence `curl (28)`.

So `poll.log` has no snapshots and `stage last seen: none`, because the loop broke out
before the first 30 s snapshot interval completed — at 11:10:45 the instance was
already shutting down, only 15 s after the poller had been running ~15 minutes with
no successful connection.

## Why port 8443 never answered

**Port reconciliation.** The capacity run uses exactly one externally reachable
port: **8443**, the single-port TLS edge. Nothing in this run used 443, and any
earlier reference to 443 was an error. Every client probe and every ingress rule
in this report is 8443. The guest's own services are loopback-only by design:
9444 for bootstrap status, 9443 for evidence, 8080 for the application behind
the edge.

**The guest-side cause is UNKNOWN, not merely unstated.** The evidence does not
establish it, and I will not guess. `curl (28)` at 11:11:05
is a probe of a dead instance. What *is* established: **no status snapshot was ever
retained**, so the poller's own connects never succeeded either, from 10:55:43 onward.
That means the edge was not serving `/status` for ~15 minutes while the instance was
running. The guest-side cause (bootstrap failure, compose never started, edge not
listening) is **UNRESOLVED** and cannot be determined from the retained evidence.

**Missing evidence needed to resolve it:** the guest's `bootstrap-status` file, the
`stage-current` value, and the tail of the bootstrap log. These live in
`/var/lib/assetflow-capacity/evidence/` **on the root volume, which was deleted** with
the instance. No such data was exported because no snapshot was ever produced.

## Proven supervisor defects

1. **Readiness deadlock.** Waits on a field that is hard-coded false. Cannot succeed.
2. **Exit status lies.** `exit 0` unconditionally, so the workflow reports `success`
   for a run that never became ready. A green job meant "cleanup succeeded".
3. **Snapshot rename/sort collision.** `ls -1t dir | head -1` then `mv` inside the same
   directory it sorts, producing `received-*` files that it then re-selects.
4. **Mandatory checks not enforced.** P3 refusal or watchdog death is recorded and then
   ignored; the loop continues and the script still exits 0.
5. **Single readiness probe, too late.** Probed once after the loop rather than
   repeatedly during observation.

## Accounting

Alternate launches that reached AWS `RunInstances` and created an instance: 6.
Instances that reached application readiness: **0**.
No acceptable Stage 3 result has ever been produced.

---

# Corrections and verification (offline, no launch)

## Supervisor defects proven and fixed

| # | Defect | Fix | Test that would have caught it |
|---|---|---|---|
| 1 | Waited for `application_ready`, hard-coded `false` — an unbreakable deadlock | Readiness taken only from `/api/health/ready`, probed **inside** the loop | `test_diagnostic_ready_false_does_not_block_a_healthy_app` |
| 2 | `exit 0` regardless of outcome; job green on a wasted launch | Exit 0/1/3/4/5 by cause; workflow captures and re-fails the job | `test_app_never_ready_fails_nonzero`, `test_complete_contract_exits_zero` |
| 3 | Renamed the newest snapshot inside the directory it then re-sorted | Basename ledger, poller files never modified | `test_poller_files_are_never_renamed` |
| 4 | P3 refusal and watchdog death recorded then ignored | Both stop the run with a nonzero status | `test_p3_refusal_stops_the_run`, watchdog tests |
| 5 | Readiness probed once, after the loop | Probed every pass while observing | `test_readiness_is_probed_inside_the_loop_not_after_it` |
| 6 | A reported `fixture_users: 0` fell through to a friendlier number elsewhere | A reported count is authoritative, including zero | `test_missing_fixtures_is_not_a_stage3_pass` |
| 7 | Malformed snapshots could be read as progress | Validated with `jq -e`; skipped and named | `test_malformed_snapshot_is_skipped_not_trusted` |

## End-to-end evidence (executed, not asserted from unit counts)

The real `supervise-run.sh` was run as a subprocess against a real ECDSA P-256 CA,
a real HTTPS server, and a simulated AWS control plane:

| Case | Exit | Verdict |
|---|---|---|
| diagnostics `application_ready=false`, app becomes healthy | **0** | complete, full contract ok |
| application never healthy | **3** | readiness not reached |
| wrong CA | **3** | no false success |
| instance terminates before readiness | **4** | terminated before confirmation |
| P3 denied | **1** | cleanup could not be guaranteed |
| watchdog dies | **1** | watchdog did not report alive |
| healthy route, zero fixtures | **5** | contract check failed: fixtures |
| complete contract | **0** | complete |

Snapshot behaviour, same real supervisor: pre-existing poller files **not**
renamed or deleted, **zero** `received-*` artefacts, malformed snapshots
**skipped and named**, run still failed honestly (rc 3).

## Stage 4 handoff

The job now holds the **runner**, not just the instance: retaining the instance
alone leaves it unreachable, because the runner's `/32` is the only permitted
source and its private CA, token and state are what can verify the run. The hold
is bounded by `STAGE4_HOLD_MINUTES` (default 45, capped at 120) and by the guest
deadline, exits early if the instance dies, and adds no AWS service or permission.

## Remaining uncertainties

1. **Why port 8443 never answered on the guest.** Not determinable from the
   retained evidence; the root volume was deleted. Missing: guest
   `bootstrap-status`, `stage-current`, bootstrap log tail.
2. The corrected supervisor has **never run against real EC2**. Everything above
   is offline with a simulated control plane.
3. Digest-pinned image readiness remains unproven on hardware.
