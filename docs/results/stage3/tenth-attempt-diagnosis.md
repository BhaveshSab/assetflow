# Tenth attempt diagnosis (run 43288456967, instance i-0d1ecc4c6cb2dcbc5)

## Executed facts (verified directly)

- Approval commit `f81071f3ff9f16da0f7a9b906501f89b6f2016bb` passed the gate on
  the first try; launch executed 2026-11-12T19:17:03Z; one t3.micro in
  ap-southeast-2b, approved configuration unchanged.
- The run FAILED before readiness. The observe step ran 19:17:13Z-19:31:55Z.
  The workflow's own cleanup then terminated the instance record, removed the
  ingress rule, and verified the account state (zero run volumes, ingress `[]`).
- Retained artifact (14 files + 85 snapshots, no absent-evidence warnings beyond
  the expected ones) proves the new observability worked:
  - `supervisor.out` records the credit balance: `0.011794` (19:20) then
    `7.09e-05` (19:25) - the guest was credit-starved from the first datapoint.
  - `poll.log`: first successful poll 19:21:21Z, `stage=deploy`.
  - Last healthy snapshot set 19:30:58-59Z: `stage=deploy`, disk 28.1% used,
    458 MB memory available, 2006 MB of 2047 MB swap free.
  - 19:31:30Z: `http_000`. Watchdog heartbeat 19:31:33Z (alive, age 6s).
  - Supervisor readiness probe: `curl: (7) Failed to connect ... after 149 ms`
    - the port was CLOSED (fast refuse), not timing out.
  - `verdict`: "instance reached terminated before readiness was confirmed".
- The console output (fetched from WSL AWS CLI before reaping) is silent from
  ~323s uptime (19:22:26Z) to death; the last lines are the deploy stage
  beginning and the first image pull starting. The ring was full (65536 B), so
  the silence means nothing more was written, not truncation of the tail.
- `StateTransitionReason` was "User initiated" for both attempt 9 and 10.

## Correlation

| Event | Attempt 9 | Attempt 10 |
|---|---|---|
| Launch | 18:25:28Z | 19:17:03Z |
| Pull phase began (console) | ~257s uptime | ~229s uptime |
| Console went silent | ~261s uptime | ~323s uptime |
| Last healthy guest snapshot | 18:39:39Z | 19:30:59Z |
| Guest port stops answering | 18:40:09Z | 19:31:30Z |
| Termination observed | ~18:40:2xZ | ~19:31:4xZ |
| Elapsed launch-to-death | ~875s | ~880s |

## Ruled out (with evidence)

- **The operator's terminal interruptions**: every command executed on the
  operator's machine during attempts 9 and 10 was read-only (`describe-instances`,
  `get-metric-statistics`, `get-console-output`, `sts get-caller-identity`,
  GitHub API GETs); the interrupts landed after the deaths; and the workflow,
  watchdog and guest are all outside the operator's terminal.
- **The watchdog**: log empty, alive (pid, heartbeat age 2-6s), and its only
  terminate path is the 14400s launch-based deadline.
- **The workflow's terminate step**: ran at 19:32:01Z, after the supervisor had
  already observed `terminated`.
- **Guest-side AWS API calls**: the instance has no instance profile, so the
  guest cannot call any AWS API. A guest-initiated termination can only be
  `/sbin/shutdown` (via `InstanceInitiatedShutdownBehavior=terminate`).

## UNKNOWN

- **The termination trigger is UNKNOWN.** The evidence narrows it to the guest's
  own `/sbin/shutdown` (some fail-closed path whose console and status writes
  were lost) or an unidentified external terminate. CloudTrail `LookupEvents`
  is denied for the run IAM user, so API-caller attribution is unavailable.
- Why the console went silent at ~320s in both runs is UNKNOWN. Both the
  bootstrap's tee'd output and the deadline guard's direct `/dev/console`
  writes stopped, while the status server kept answering for another ~9 minutes.
- Near-zero CPU credits are real but do not by themselves terminate an instance;
  they are not claimed as the cause.

## Correction shipped (commits c53afd4, afc5fda, and the review fix)

Bootstrap-error shutdown paths (`die()`, `on_error()`) record the reason and
hold a bounded evidence window so the 30s off-host poller captures
`failed: <reason> (evidence-window=Ns shutdown-pending)` via /status before the
network drops. `on_error()` also writes the failure-summary marker now (only
`die()` did). The guard embed is gzipped (like the TLS material) to stay inside
the 16 KiB user-data cap.

A review found that the first version of this correction also delayed the
deadline guard's shutdown by the window - a safety regression, because the
four-hour limit is a maximum, not a deadline after which evidence collection
begins. Corrected: deadline-guard.sh's `shut_down()` is immediate again (no
window, no sleep anywhere in the guard), and the bootstrap window is capped by
the remaining approved lifetime (a 120s margin is kept for the shutdown and
cleanup) and skipped entirely when the deadline cannot be validated (for
example a die() before the config is sourced). Executable regression tests
cover deadline expiry and invalid-deadline immediacy (elapsed < 10s) and the
window cap/skip behaviour, run against the real rendered function text.
Fail-closed cleanup is unchanged: every path still terminates the instance.

No configuration change (CPU credits, instance type) was made or armed. If the
next failure's captured reason shows a throttle-induced timeout, that becomes
the evidence for a configuration recommendation; until then none is claimed.
A captured reason is possible, not guaranteed: an externally initiated
termination may remain UNKNOWN.
