# Stage 3 execution observation log

Authoritative timestamp source: UTC clock. Instance time is AWS `LaunchTime`.

| Event | Time (UTC) | Evidence |
|---|---|---|
| Consumer launch (confirmation) | 13:20:20 | `RunInstances --dry-run` -> `UnauthorizedOperation` (ENI untagged) |
| Corrected consumer dry-run | 13:26:13 | `RunInstances --dry-run` -> `DryRunOperation` |
| **Instance launched** | **13:34:49** | `LaunchTime=2026-11-09T13:34:49.000Z` |
| P3 termination dry-run | 13:34:49 | `TerminateInstances --dry-run` -> `DryRunOperation` |
| First TCP/8443 probe: closed | 13:37:22 | connection refused |
| Black-box readiness polls: all closed | 13:37:22 - 14:26:39 | 60+ probes, all connection failures |
| Last closed probe | 14:26:39 | |
| **Instance terminated** | between 14:26:39 and 14:33 | `Client.InstanceInitiatedShutdown` |

Not observed: a single successful TCP connection, TLS handshake, or HTTP response on
8443. `openssl s_client -connect ...:8443` returned no handshake at the final probe.

## Why the instance stopped

Two candidate causes were distinguished:

* **Deadline guard firing on schedule** — *ruled out*. The rendered payload carried
  `LAUNCH_EPOCH=1794231251` (2026-11-09T13:34:11Z), so the guard's absolute deadline
  was **17:34:11Z**. The instance terminated between 14:26:39Z and 14:33Z, roughly
  **three hours early**. A correctly-functioning deadline cannot produce that.
* **Bootstrap failing closed** — *concluded*. The user-data shuts the guest down when
  a required stage fails, and `InstanceInitiatedShutdownBehavior=terminate` then ends
  the instance. `StateTransitionReason` was `Client.InstanceInitiatedShutdown`, which
  is exactly the signature of that path (rather than `Server.InsufficientInstanceCapacity`
  or a platform stop).

The bootstrap therefore did **not** reach the point of opening 8443. Because no
connection was ever accepted, the failure happened before the edge came up, i.e.
during or before the application build/start stage.

### What was NOT observable

No SSH and no SSM by design, so the guest's stdout and the journal could not be
read after termination. `ec2:GetConsoleOutput` was never granted to this identity,
so the serial console is unavailable too. The precise failing stage is therefore
**not proven** — it is inferred from the absence of any listener plus the
fail-closed shutdown signature. This is recorded as a limitation, not glossed over.

## Correction to the earlier record

The first report of this incident said the safety mechanics "worked". That was
too generous and is corrected here.

* **The guest deadline service did not work as intended.** The system log shows
  `capacity-deadline.service` reporting repeated FAILED activations while the build
  was still running. A guard that is supposed to be invisible when nothing is wrong
  was in fact visibly failing.
* **The operator watchdog never ran.** It was prepared to bind to the returned
  instance ID but the run never reached that step, so it was never started. The
  earlier text described the mechanism from reading the code, not from observing it
  running, and should not have implied otherwise.

What *is* accurate: the bootstrap's fail-closed shutdown did fire, and
`InstanceInitiatedShutdownBehavior=terminate` did end the instance and delete the
volume. That part behaved correctly.

## Proven cause versus unresolved cause

**Proven: storage exhaustion.** The system log shows the image build reaching npm ci,
Prisma generation and Nest compilation, and then the export failing with
`failed to write compressed diff` / `no space left on device`, with journald reporting
`Failed to create new system journal: No space left on device`. The root volume was
8 GB because the launch command supplied no block device mapping and the AMI default
applied. The bootstrap then reported `[bootstrap][FATAL] migration failed`, which is
a generic label from the `die` path and is **broader than the actual failure** - no
SQL migration of ours failed.

**Unresolved: the deadline service.** Its own logic was ruled sounds by direct test:
real systemd activated it repeatedly, it stayed silent before the deadline, it failed
closed on a malformed and on an unreadable deadline, it tolerated a read-only evidence
directory, and every exit path returns 0. The most likely explanation is that systemd
could not journal a unit while the disk was full, but that is **not proven**, and the
generic "Failed to start" message is not evidence for it.

## Event time versus observation time

The bootstrap failed at **14:03:36Z** according to the system log. My black-box
readiness polling continued to report "no listener" until **14:26:39Z**, and I
described the termination as happening in a window around then. Both are consistent:
the instance stopped serving at 14:03:36Z, and my probes could not distinguish "never
started listening" from "stopped listening" without SSH or the console. The log time
is authoritative for the failure; my polling interval only bounds when I noticed.
