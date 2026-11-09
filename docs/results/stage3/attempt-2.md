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
