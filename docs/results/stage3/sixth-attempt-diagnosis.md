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

The evidence does not establish this, and I will not guess. `curl (28)` at 11:11:05
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
