# Stage 3, attempt 4 — the migration gate passed on real hardware; seeding still failed

One instance, one launch, no retry, no load test.

`i-09427c10a104f78d6`, launched 2026-11-10T15:39:10Z, public IPv4 `54.206.196.47`,
terminated by the guest between 16:43:01Z and 16:52:30Z. The deadline was
19:38:45Z, so the deadline did not end it.

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

Watchdog bound to the exact ID, heartbeat advancing (1794325167 → 1794325230 →
1794329547), and it exited cleanly at 16:52:30Z on reading `terminated`.

## What this attempt proved

The migration gate works on real hardware. This is the first time on EC2:

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

Every part of the corrected gate is visible and passed: the build came from the
pinned checkout rather than a registry pull, the migration ran in the foreground,
exited 0, and the schema was verified **against the database** before seeding.
`stage-done: deploy` followed, so the gate is a gate.

## Where it failed

`[fixtures] seeding 200 account(s)` began at t=3925 s. The instance was gone
within the next ~55 minutes.

**The failure message is not recoverable.** The EC2 console is a ring buffer:
`GetConsoleOutput` returns a fixed-size window, and the verbose Docker build
output (~58 minutes of layer progress) had already pushed the later lines out.
Repeated reads returned a buffer frozen at `14052s remaining`, well before the
end. So the seed's own error, and the exact line that called `die()`, are
**unobserved** for this attempt as well.

What is known:

* no FATAL line appears in the buffer, but the buffer does not reach the failure;
* no OOM kill and no "no space left on device" appears in the retrieved window;
* the disk preflight reported `root=28691MB available=23875MB required=12000MB`;
* the guest initiated shutdown (`User initiated` + `terminate` behaviour), which
  is the fail-closed path in `die()` or `on_error()`;
* the root volume is deleted (`InvalidVolume` on direct lookup).

## Why the console could not hold the answer

This attempt fixed the migration defect and hit a **retrieval** limit instead.
A 58-minute image build on a credit-throttled t3.micro produced enough console
output to evict the outcome from the ring buffer before anyone could read it.

That is a different problem from the one that was fixed, and it needs a different
remedy: the bootstrap must push its status somewhere that does not depend on the
console window, or retention must be decoupled from build verbosity.

## What is still unproven

Fixture seeding on EC2, application health, HTTPS edge readiness, authenticated
readiness, host metrics and the checksum-verified export are all still unproven
on the target hardware. CI proves them; this attempt did not reach them.

## Inventory

0 run-owned instances, 0 volumes, 0 elastic IPs. SG `sg-012a0191f4e4a9a8c` inbound
**0**. Production `i-0ff4690ec52d0dc01` running.
