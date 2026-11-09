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
