# Stage 3, attempt 3 — bootstrap reached `fixtures`, then failed loudly and correctly

Budget boundary honoured: one instance, one launch, no retry, no load test.

## What was fixed before this attempt, and proven here

Both earlier failures were root-caused from the console and closed:

* the payload carried a short SHA, so `deployed e4fe01babc… != expected e4fe01b`
  always fired; the launcher now resolves to the full 40-character commit;
* `strip_comments` deleted the deadline guard's `#!/bin/bash`, so
  `capacity-deadline.service` failed on every tick with no interpreter.

The second fix is now proven on a real instance rather than in a sandbox. The guard
activated repeatedly and reported through to the console:

```
capacity-deadline: run dir=/var/lib/assetflow-capacity deadline_file=... now=1794318855
capacity-deadline: 13925s remaining (deadline 1794332780)
OK  Finished capacity-deadline.service - capacity run deadline enforcement.
```

That is the first time in this whole effort that the deadline service has reported
success on real hardware. The diagnosis that stayed unresolved across two attempts is
closed, and it was an interpreter problem, not logic, disk or journald.

## Instance and verified configuration

`i-0b117ad26bf5c6988`, launched 2026-11-10T13:46:51Z, public IPv4 `16.178.221.157`.

| Property | Value |
|---|---|
| type / AZ | t3.micro / ap-southeast-2b |
| root | `vol-08c9d9ba019425f8e`, **30 GB gp3**, `/dev/sda1`, DeleteOnTermination=true |
| credits | `standard` |
| shutdown behaviour | `terminate` |
| tags | Project=assetflow-capacity, RunId=cap-20261109t0800z-a7f3 |
| key pair / instance role | none |

P3 `TerminateInstances --dry-run` returned `DryRunOperation`.

Watchdog was started and **verified live**, not merely started: heartbeat advanced
1794318624 → 1794318688 → 1794319218 while the guest was bootstrapping.

## How far the bootstrap got

```
== inputs ==
== deadline (pre-packages) ==
== packages ==            == packages done ==
== code ==                == code done ==
== application configuration ==
== deploy ==
== fixtures ==            <-- failure here
```

`code done` is past the exact point that killed attempt 2. `deploy` completed a real
Compose build of the images. The run died in `fixtures`.

## The failure, named exactly

```
capacity-bootstrap: FATAL: fixture seeding failed (see seed.log) (stage=fixtures line=255)
[bootstrap][FATAL] fixture seeding failed (see seed.log)
```

This is the whole point of the observability work: an earlier version of this would
have been an unexplained shutdown with a delayed console. Instead the report names the
stage and the line. The fail-closed path then behaved as designed — `poweroff.target`,
`reboot: Power down`, and `InstanceInitiatedShutdownBehavior=terminate` removed the
volume.

`seed.log` holds the underlying reason and was not captured to the console, by design:
diagnostics are bounded and must not dump environments or credentials. The next attempt
should surface the seed command's exit code and a redacted tail on the console.

## Cleanup, verified

0 run-owned instances, 0 volumes. `vol-08c9d9ba019425f8e` returns `InvalidVolume.NotFound`,
which is the evidence that DeleteOnTermination took effect. 1 inbound SG rule remains
(tcp/8443 from the operator's /32) pending explicit approval to remove.

## Verdict

**FAIL** — readiness was not reached, so nothing was measured. No load test was run and
no capacity conclusion may be drawn. The configuration, the deadline guard and the
failure diagnostics all worked exactly as intended; the remaining defect is fixture
seeding.
