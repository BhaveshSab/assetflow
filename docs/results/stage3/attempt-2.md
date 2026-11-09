# Stage 3 retry attempt 2 — outcome

Approved SHA at launch: `e4fe01b`. Instance **`i-0146fabb061769b96`**.

## What the preconditions established

All eight were executed before launch and all passed:

1. caller `arn:aws:iam::459252806274:user/assetflow-capacity-run`, zero active instances, zero inbound rules;
2. the three previously denied reads now work — `DescribeInstanceAttribute` returned
   `stop`, `DescribeInstanceCreditSpecifications` returned `unlimited`, and
   `GetConsoleOutput` returned real kernel text from production (read-only);
3. the embedded guard is proven executable *before* the timer is enabled, by running
   the real payload's early section under real systemd with its own embedded guard:
   1 410 bytes, 5 activations, no early shutdown;
4. the guard emits its deadline file, value, timestamp and, on failure,
   `SHUTDOWN: failed: deadline-epoch malformed (non-numeric: 'garbage')`;
5. the watchdog was demonstrated terminating by exact ID after re-verifying the
   RunId tag (`deadline reached (launch-based); terminating i-EXACTID` → `terminate accepted`),
   not merely passing a dry run;
6. the subnet reports `MapPublicIpOnLaunch=true` and the launcher now asserts it and
   reads the returned address back;
7. payload 14 702 bytes, pinned commit present, plain-text shell, `bash -n` clean,
   live dry run returned `DryRunOperation` with the 30 GB gp3 root on `/dev/sda1`;
8. a new client token `cap-20261109t0800z-a7f3-retry2-...` was generated and preserved,
   deliberately not the failed attempt's token.

## The launch

| Check | Result |
|---|---|
| Instance | `i-0146fabb061769b96` |
| Type / AZ / AMI / subnet / SG | t3.micro, `ap-southeast-2b`, `ami-01e91e94accc42eec`, `subnet-01f25dc99e013aa6a`, `sg-012a0191f4e4a9a8c` |
| Tags | Project=assetflow-capacity, RunId=cap-20261109t0800z-a7f3 |
| **Root volume** | **`vol-0e97a3fbee8464673`, 30 GB gp3 on `/dev/sda1`, DeleteOnTermination=True** |
| Shutdown behaviour | `terminate` |
| CPU credits | `standard` |
| Key pair / instance role | none / none |
| Public IPv4 | `3.26.182.253` (asserted, not assumed) |
| P3 termination dry-run | **`DryRunOperation`** |

The 8 GB → 30 GB defect from attempt 1 is fixed and verified on the live volume.

## What happened next

The instance **terminated itself ~4 minutes after launch** (launch 15:27:25Z, shutdown
observed 15:31:35Z), far short of the 19:26:47Z deadline. `StateTransitionReason` was
`User initiated`, and the root volume was deleted, confirming `DeleteOnTermination`.

The **console was completely empty** (2 bytes), so the failing line is unknown. The
payload was structurally valid: `bash -n` clean, every required variable present,
heredocs correctly delimited, no missing dependency.

The only consistent explanation is a failure in the payload's **prelude**, which ran
under `set -e` before the bootstrap had a log file, a `say()` or a `die()`, and so
aborted without writing anything to any readable location. **That is a diagnosis of
the reporting gap, not of the underlying fault.** The underlying fault remains
**unknown**, and is recorded as unknown.

## Correction made in response

The prelude now installs an `ERR` trap as its first act, reporting the exit code and
line number to `/dev/console` (independent of the root volume, the journal and the
bootstrap's own logging) plus a fatal line on stderr. Proven by forcing a failure:
`[bootstrap][FATAL] prelude failed (rc=1) at line 21`.

Validated at `d0cb910`: 50 contract tests, full clean-clone suite, CI run
`42646305651` all seven jobs success.

## State after this attempt

Zero active run-owned instances, zero volumes, zero elastic IPs. One inbound rule
`tcp/8443` from `157.48.109.250/32` remains on the run SG, left in place because its
removal was not approved for this attempt. Production running. No load test was run.

## Correction: the console was never empty

I previously recorded the console as empty (2 bytes) and treated the cause as unknown.
That was wrong. Retrieval was delayed, not absent.

| Retrieval | When | Result |
|---|---|---|
| during the attempt | ~15:31Z | `len=0` |
| after termination | 15:43Z | `len=65229`, `Timestamp=2026-11-09T15:34:45Z` |

An empty `GetConsoleOutput` proves only that nothing was available **at that moment**.
It is not evidence that the prelude did not run, and it must never be described as one.
The underlying fault was always knowable from the guest; I simply asked too early.

## Proven root cause 1: a short SHA could never match

The payload carried `EXPECTED_COMMIT=e4fe01b`, but the bootstrap compares against
`git rev-parse HEAD`, which is always 40 characters:

```
[bootstrap] disk: root=28691MB available=23876MB required=12000MB
[bootstrap] == code ==
[bootstrap][FATAL] deployed e4fe01babc0e1eeade2808a59d9fdeed5260b289 != expected e4fe01b
```

The guard was right to refuse. Shutdown followed, and `InstanceInitiatedShutdownBehavior`
deleted the volume. Note the disk line: a real 30 GB root with 23 876 MB free, so the
earlier 8 GB exhaustion was genuinely fixed and is not a factor here.

The launcher now resolves a short SHA through `git rev-parse --verify` and refuses to
render if it cannot, so this cannot be expressed again.

## Proven root cause 2: the deadline guard was deployed without an interpreter

`capacity-deadline.service` failed from its very first tick in both attempts, at ~28s:

```
Started capacity-deadline.timer - deadline timer (absolute, launch-based).
Starting capacity-deadline.service...
FAILED Failed to start capacity-deadline.service - capacity run deadline enforcement.
```

No `capacity-deadline:` line ever appeared, so the guard body never ran. The cause is in
the renderer: `strip_comments` deleted every line beginning with `#`, including the
guard's `#!/bin/bash`. The deployed file had no shebang, so `ExecStart` failed instantly.
The strip now preserves a shebang, and the embedded guard is verified to execute through
it and to fail closed on a malformed deadline.

This closes the deadline-service diagnosis that stayed unresolved across both attempts,
and it means the earlier FAILED was not a logic fault, not a disk effect, and not a
journald effect.

## What was NOT wrong

* `set -e` did not power the instance off. The shutdown came from `die()` and from
  `InstanceInitiatedShutdownBehavior=terminate`, both intentional.
* npm deprecation warnings played no part.
* No SQL migration failed; the `migration failed` label is a generic `die` message.
* The disk was correctly sized.

## Observability, proven on the full payload

Diagnostics were previously absent exactly where they were needed. Executing the
**complete rendered payload** (not a snippet) in a sandbox against the real control flow
now produces, for the very failure that killed this attempt:

```
capacity-bootstrap: FATAL: deployed deadbeef... != expected e4fe01babc... (stage=code line=217)
```

and, for an unguarded failure, `unexpected failure rc=7 at line=16 (stage=deploy)`.
Both reach `/dev/console` and the local log; neither prints commands, environments or
secret values. Stage entry and completion markers bracket every stage, network and
package steps are bounded by `timeout`, and the start marker is emitted before the config
is sourced without assuming variables exist under `set -u`.
