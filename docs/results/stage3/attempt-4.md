# Stage 3, attempt 4 — migration gate passed; fixture execution failed, cause unknown

One instance, one launch, no retry, no load test.

`i-09427c10a104f78d6`, launched 2026-11-10T15:39:10Z, public IPv4 `54.206.196.47`.
The deadline was 19:38:45Z. The instance was no longer running when the watchdog
polled at 16:52:30Z, and the watchdog exited at that point.

## Verified configuration

| Property | Value |
|---|---|
| type / AZ | t3.micro / ap-southeast-2b |
| root | 30 GB gp3, `/dev/sda1`, DeleteOnTermination=true (tagged) |
| credits | `standard` |
| shutdown | `terminate` |
| key pair / instance role | none |
| tags | Project=assetflow-capacity, RunId=cap-20261109t0800z-a7f3 |
| commit | `18e9f47d488d66c1af6408b448fbf3b0cc001c07` |
| P3 | `DryRunOperation` |

## PROVEN: foreground migration and database-state verification passed

Observed on the console, in order:

```
[ 250.074831] [migrate] building images from the pinned checkout
[3766.232609] [migrate] images
[3766.313427] [migrate] starting dependencies
[3847.993840] [migrate] running migrations (foreground, timeout 900s)
[3892.724539] [migrate] migration container exited 0
[3892.724828] [migrate] verifying schema state against the database
[3925.517408] [migrate] database schema is current and the User table exists
[3925.589365] capacity-bootstrap: stage-done: deploy
[3925.591309] capacity-bootstrap: stage-begin: fixtures
```

The build came from the pinned checkout rather than a registry pull, the migration
ran in the foreground, exited 0, and the schema was verified against the database
before seeding. `stage-done: deploy` followed, so the gate is a gate.

## UNKNOWN: the fixture execution failed or was interrupted

`[fixtures] seeding 200 account(s)` began at t=3925 s. The instance was not
running within the next ~55 minutes.

**The underlying error was not observed.** `GetConsoleOutput` is a fixed-size
window; 58 minutes of Docker layer output had already pushed later lines out, and
repeated reads returned a buffer ending at `14052s remaining` — before the
failure. Nothing in the retrieved window names the cause.

The only exit status reachable is the container's: not captured, because the
volume was deleted with the instance.

## UNPROVEN: application readiness

No health check, HTTPS edge, authenticated readiness, host metrics or
checksum-verified export was reached. CI exercises all of them; this attempt did
not get there. **Readiness is not proven on the target hardware.**

## What the console evidence does and does not establish

* Console truncation and delivery delay are a **possible** evidence-loss
  mechanism. They are **not** proven from a frozen response alone: a buffer that
  stops advancing is consistent with truncation, with the guest stopping, and
  with the API returning a stale snapshot.
* Guest-guard evidence applies **only** to the timestamps actually observed
  (`14113s` and `14052s` remaining). Nothing is claimed about the guard after the
  last retrieved line.
* **No process is asserted as the terminator.** `StateTransitionReason` is
  `User initiated`, which is what EC2 reports for both an operator call and a
  guest-initiated shutdown. The watchdog began logging it could not read the
  instance state at 16:43:01Z and saw `terminated` at 16:52:30Z; it did not
  terminate the instance, but that does not identify who did.

## Inventory

0 run-owned instances, 0 volumes (root deleted), 0 elastic IPs. SG
`sg-012a0191f4e4a9a8c` inbound **0**. Production `i-0ff4690ec52d0dc01` running.
