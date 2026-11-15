# Seventh attempt diagnosis — watchdog contract mismatch

Run `43224628030`, head `daaa9600b1881738cdcfdfdc7321f0db5faa3f9c` (approval
commit; tree identical to tested `d1844a9`). Verdict: **FAIL, 44s after launch**.

## What happened

- `i-0ca72de359b95c62f` launched 13:10:13Z, terminated 13:10:57Z
  ("User initiated") by the workflow's terminate-if-failed path.
- Failure detail: `Stage 3 verdict: fail (watchdog did not report alive within 30s)`.
- The approval gate itself opened correctly on the first attempt (run_attempt 1,
  exact 40-char sha match), so the gate mechanism is proven.
- Cleanup verified complete: instance terminated, zero run volumes, SG ingress
  `[]`, production untouched. Evidence artifact (665 B) retained on the run.

## Root cause (proven from committed code, not guessed)

`supervise-run.sh` started the watchdog like this:

    bash operator-watchdog.sh --instance "$ID" --state-dir "$SD" --max-minutes "$N"
    sleep 30
    grep -q alive "$SD/watchdog-status" || fail

The real `operator-watchdog.sh` contract is:

    operator-watchdog.sh <instance-id> [lifetime-seconds]
    state dir: WATCHDOG_STATE_DIR env (default /var/lib/capacity-watchdog)
    liveness:  `pid` + a numeric epoch `heartbeat` rewritten every poll cycle

So the watchdog received `--instance` as its positional instance id, ignored
unknown flags, wrote its state to the DEFAULT directory (not the run's state
dir), and never wrote `watchdog-status`. The supervisor's 30-second wait could
only ever fail. Nothing on the guest was wrong.

## Why six CI-green runs did not catch it

`test_supervisor_contract.py` stubbed the watchdog with
`echo alive > "$SD/watchdog-status"` — the supervisor and its stub agreed with
each other and with nothing else. Both sides were tested against their own
invention of the interface. The same class of blind spot existed for:

- `--cacert "$TRUST_DIR/ca.crt"` — no `ca.crt` exists; `generate-trust.sh`
  produces only `tls.crt`/`tls.key`/`evidence.token`. Readiness probing would
  have failed next.
- `snapshot-evidence.sh --state-dir … --out …` — that script parses no
  arguments (it is the guest's RUN_DIR-based publisher). The final export
  check would have failed after that.

## Fixes (this revision)

1. Supervisor invokes the watchdog positionally with `WATCHDOG_STATE_DIR`
   pointing at the run's state dir; lifetime stays 14,400s measured by the
   watchdog from the actual AWS LaunchTime — deliberately NOT derived from
   `--max-minutes` (observation timeout and instance lifetime are different
   controls).
2. Liveness is proven, not assumed: bounded startup polling (≤30s) requires the
   recorded pid to exist and the heartbeat to be numeric, recent and advancing;
   the same check re-runs every observation pass. Stale, malformed, absent or
   implausibly-future heartbeats each fail with the specific reason, mirrored
   into `watchdog-status` for the outcome record, with the watchdog's own
   output preserved on startup failure.
3. Trust path corrected to `tls.crt` (the file that actually exists).
4. Export checksum computed by the supervisor over its own retained snapshots;
   no argument contract invented for the guest publisher.
5. New integration harness `infra/tests/integration/watchdog-supervisor.sh`
   runs the REAL supervisor + REAL watchdog + REAL poller together; only AWS
   (a recording fake) and the guest's public HTTPS port are simulated. 35
   checks: correct instance id/lifetime reach the watchdog, `--max-minutes`
   never changes the watchdog lifetime, heartbeat advances, wrong RunId
   refuses to act, AWS read failure is visible without faking liveness,
   death/stall/malformed/future heartbeats each fail with the reason, a
   deadline termination targets exactly the verified instance once, and failed
   verdicts plus diagnostics are preserved.
