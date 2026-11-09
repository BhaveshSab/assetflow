# Capacity run — final instance-launch checkpoint

Status: **PREPARED, NOT EXECUTED.** Nothing below has been run. No instance, no
volume, no ingress, no load test. Production is untouched.

Pinned code and the pinned AMI are recorded so the run is reproducible from this
document alone.

A note on the budget: AWS Budgets accepts `SubscriptionType=EMAIL` directly, so
no SNS topic and no IAM change is needed. The budget is a **delayed alert**, not
a hard spending limit — it cannot stop an instance. See section 3.

## 1. Pinned versions

| Item | Pinned value |
|------|--------------|
| Repository commit | the PR head SHA named in the approval request, which must be the CI-tested SHA |
| AMI | `ami-01e91e94accc42eec` |
| Instance type | `t3.micro` |
| Region / AZ | `ap-southeast-2` / `ap-southeast-2b` |
| Subnet | `subnet-01f25dc99e013aa6a` |
| Security group | `sg-012a0191f4e4a9a8c` (existing run-owned, **inbound empty**) |
| Key pair | **none** — `--no-key-name`, no SSH |
| CPU credits | `CpuCredits=standard` |
| RunId | `cap-20261109t0800z-a7f3` |
| Project tag | `assetflow-capacity` |

The AMI is pinned by ID, not by "latest". A different AMI is a different run.

## 2. Complete launch configuration

This is the request that returned `DryRunOperation` in P2, extended with the two
lifecycle settings required by section 4. `--dry-run` is the only removed flag.

```bash
export MSYS_NO_PATHCONV=1
aws ec2 run-instances \
  --image-id ami-01e91e94accc42eec \
  --instance-type t3.micro \
  --subnet-id subnet-01f25dc99e013aa6a \
  --security-group-ids sg-012a0191f4e4a9a8c \
  --associate-public-ip-address \
  --credit-specification CpuCredits=standard \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3},{Key=Name,Value=assetflow-capacity-host}]' \
    'ResourceType=volume,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]' \
    'ResourceType=network-interface,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]' \
  --user-data file://capacity-run-user-data.sh \
  --profile capacity --region ap-southeast-2
```

`--instance-initiated-shutdown-behavior terminate` and the volume's
`DeleteOnTermination=true` are both required; section 4 explains why a guest
shutdown without the first one leaks the volume. Neither is taken on trust — both
are read back after launch (section 6).

P2 did **not** include these two settings, so this exact request has not been
dry-run. P3 and the post-launch read-back are what confirm them.

## 3. Cost

Verified unit prices (`pricing:GetProducts`, Sydney, queried 2026-11-09):

| Item | Price | 4 h |
|------|-------|-----|
| t3.micro | $0.0132/h | $0.0528 |
| gp3 30 GB | $0.096/GB-month | $0.0132 |
| Public IPv4 | $0.005/h | $0.0200 |
| **Sum of the above** | | **$0.0886** |

### These are partial estimates, not worst-case charges

$0.0886 (4 h) and $0.0997 (4.5 h) cover only the three lines above. **Not
included**, because they are not priced here and some are not knowable in advance:

* **Data transfer out** — the load test's response bytes to the generator. Not
  zero, and the largest omission. A few hundred MB at Sydney egress rates would
  exceed the compute line.
* **Data transfer in** — normally free, assumed free here.
* **EBS I/O** — gp3 includes 3,000 IOPS and 125 MB/s; above that is billed
  separately and is not counted.
* **EBS snapshots** — none are created by this run; excluded on that basis, not
  measured.
* **Requests to other AWS services** — S3, CloudWatch, and any API calls the app
  makes under load.
* **Cost Explorer and Budgets** — no charge at these volumes, assumed zero.
* **Rounding and price changes** — the quoted prices are current, not guaranteed
  for the duration.

So the honest statement is: **the compute, storage and IPv4 lines total $0.0886
for four hours; total spend will be higher, and its size depends mainly on egress
volume, which this document does not estimate.**

### The $5.00 target is not enforced

$5.00 is a **monitoring target and a manual abort threshold**. It is not a
technical control:

* IAM does not cap spend — the policy restricts *which* actions and resources,
  not how much they cost.
* AWS Budgets does not stop anything; it sends a delayed email.
* Cost Explorer reports spend after the fact and cannot block a request.

Nothing in this run can stop an instance for costing too much. The only real
limits are the 4-hour lifetime and manual teardown. Treat $5.00 as a tripwire that
prompts a human, not a wall.

### The budget is a delayed alert, not a cutoff

| Property | Value |
|----------|-------|
| Name | `cap-20261109t0800z-a7f3` |
| Type | cost budget, **notification only** — no budget actions |
| Amount | USD $1.00 |
| Subscriber | `SubscriptionType=EMAIL` (direct email; no SNS) |

AWS Budgets evaluates spend periodically and emails when a threshold is crossed.
The delay is on the order of hours, and the notification can arrive after the run
has ended. **A budget cannot stop, terminate or throttle anything.** It exists to
tell a human that something is wrong, for the case where the run overruns.

Configuring the notification successfully is **not** the same as verifying that
delivery works. A budget email cannot be confirmed without waiting for a threshold
to actually be crossed, which this run will not do. So the report will state
"notification configured" and will **not** claim "alerts are being delivered".

## 4. Lifetime enforcement, and why it must terminate rather than stop

The load test must not be the only thing that ends the run: if it hangs, crashes
or never starts, nothing would stop the clock.

### A guest shutdown alone would leak billable storage

`InstanceInitiatedShutdownBehavior` accepts only `stop` or `terminate`, and the
**default is `stop`**. A plain `shutdown -h now` inside the guest therefore stops
the instance — compute billing pauses, but the **EBS volume keeps billing**.

This is the trap in "schedule a shutdown timer": stopping is not cleaning up.

### Launch configuration must set both of these

Two settings must hold. The full command is in section 2; these are the two
lines that matter for lifecycle:

```bash
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
```


Two settings must both hold, and each is verified separately after launch:

| Setting | Value | What it prevents |
|---------|-------|------------------|
| `InstanceInitiatedShutdownBehavior` | **`terminate`** | a guest shutdown stopping rather than terminating |
| root volume `DeleteOnTermination` | **`true`** | the volume surviving termination |

`DeleteOnTermination` is confirmed from `describe-instances` →
`BlockDeviceMappings[].Ebs.DeleteOnTermination`, not assumed from the request.
With both true, a guest shutdown destroys the instance **and** its volume.

### Executable watchdog behaviour

**Primary — in-guest timer (user-data):**

```bash
#!/bin/bash
set -euo pipefail
# Marker the readiness check reads back. Absence proves the timer is NOT armed.
exec > >(tee -a /var/log/capacity-timer.log) 2>&1
systemd-run --on-active=4h --unit=capacity-deadline   --description="capacity run deadline" /sbin/shutdown -h now
sleep 1
systemctl is-active capacity-deadline.timer > /var/lib/capacity-timer-armed
```

The timer calls `shutdown`, which under `shutdown-behavior=terminate` terminates
the instance and deletes the volume. It lives outside the load-test process tree,
so a hung generator does not stop the clock.

**Secondary — operator-side watchdog, independent of the instance:**

```bash
# Runs locally at T+4h. Does not require the instance to be reachable.
sleep 14400
aws ec2 terminate-instances   --instance-ids "$PINNED_INSTANCE_ID"   --profile capacity --region ap-southeast-2
```

It targets one pinned ID — no filter-based mass termination.

### What happens when each path fails

| Failure | Consequence | Mitigation |
|---------|-------------|------------|
| **cloud-init fails before the timer is installed** | the guest will never self-terminate | the operator-side watchdog is independent of the guest; the readiness check refuses to accept the instance without `/var/lib/capacity-timer-armed`, so the run aborts instead of proceeding |
| **operator watchdog loses connectivity** | the in-guest timer may still terminate | both must fail for the run to overrun; if connectivity is lost, teardown is re-attempted on reconnect and the overrun is reported |
| **both fail** | the instance runs past 4 h at $0.0132/h (≈$0.32/day) | abnormal; manual teardown, reported as such. Bounded by the cost tripwire, which is monitored, not enforced |

**The timer is not claimed to be active before readiness evidence confirms it.**
Section 6 reads back the marker file and the timer unit state; until that passes,
the run is not considered protected and does not start load.

## 5. Leftover billable storage

Even with `DeleteOnTermination=true`, a detached or orphaned volume can survive.
After termination the sweep covers three resource types, each with the correct
query — `length(@[])` is invalid for security groups and silently reported 0
earlier in this work:

```bash
for r in instances volumes; do aws ec2 describe-${r}   --filters 'Name=tag:RunId,Values=cap-20261109t0800z-a7f3'   --query 'length(Reservations)' ; done
aws ec2 describe-security-groups   --filters 'Name=tag:RunId,Values=cap-20261109t0800z-a7f3'   --query 'length(SecurityGroups)'
```

| Resource | Expected after teardown | If not |
|----------|------------------------|--------|
| instances | 0 | delete run-owned volumes, then re-terminate |
| volumes | 0 | delete by volume ID, then re-check |
| security groups | 0 (deleted last) | delete only if no run-owned ENI remains |
| public IPv4 | released | confirm the instance's address is gone |

## 6. Readiness checks before any load

1. instance state `running`, status checks `2/2 passed`
2. memory gate: `sum(RSS) <= 70%` of 1024 MB measured **before** the ramp
3. Nginx rate limiter present and unchanged: `rate=100r/s`, `burst=200`,
   `limit_req_status 429`. Not raised for this run
4. API throttle 300/60000ms per user
5. app answers over HTTPS from the generator
6. CPU credit mode read back as `standard`
7. baseline cost read from `ce:GetCostAndUsage`

### Lifecycle read-backs — required before load starts

These confirm the settings from section 2 actually took effect. None is assumed
from the request.

| Check | How | Pass condition |
|-------|-----|----------------|
| shutdown behaviour | `describe-instances` → `InstanceInitiatedShutdownBehavior` | `terminate`, **not** `stop` |
| volume deletion | `describe-instances` → `BlockDeviceMappings[].Ebs.DeleteOnTermination` | `true` for every mapping |
| timer armed | read `/var/lib/capacity-timer-armed` (written by user-data after the unit starts) | file exists and contains `active` |
| timer scheduled | `systemctl show capacity-deadline.timer -p NextElapseUSecMonotonic` | a future elapse time |
| watchdog tested | dry-run the operator command against the new ID (that is P3) | `DryRunOperation` |

**If the timer marker is absent, the instance is unprotected.** cloud-init may have
failed, and the guest will never self-terminate. That is an abort: terminate the
instance, keep the evidence, and do not run load.

A failed check aborts to teardown; it does not proceed.

## 7. Access rules actually needed — recorded, NOT applied

**Current state: inbound is empty.** The security group has no inbound rules and
it stays that way until the change below is explicitly approved.

Two distinct clients must reach the instance over HTTPS, and both come from
GitHub-hosted runners, not from a fixed office address:

| Client | What it does | Needs |
|--------|--------------|-------|
| Load generator | drives the k6/load script against the API | 443/tcp to the instance |
| Evidence download client | fetches the run tarball from the evidence endpoint | 443/tcp to the instance |

### Why a source CIDR is hard here

GitHub-hosted runners do not have stable IPs. The published ranges are the
`actions` entries in `https://api.github.com/meta`. Using them means a CIDR set,
not a single `/32`.

**Proposed rule, subject to approval:**

| Type | Protocol | Port | Source |
|------|----------|------|--------|
| Ingress | tcp | 443 | GitHub Actions ranges (`actions` from `api.github.com/meta`), as a CIDR list |
| Ingress | tcp | 22 | **none** — no key pair is attached, SSH is impossible |

443 is the only port needed. Opening 22 would add no capability and no risk
reduction; it is simply unnecessary.

**Narrower alternative if you prefer:** run the generator and the evidence client
from a host with a known egress IP and allow only that `/32`. This is tighter than
the GitHub range list and is the better choice if one is available.

Both clients authenticate at the application layer (the evidence endpoint uses a
bearer token over TLS), so the CIDR is defence in depth, not the only control.

**The rules are not added by this document.** Applying them is a separate approval
and a separate change to `sg-012a0191f4e4a9a8c`.

## 8. P3 termination dry-run — immediately after launch

Run right after the instance exists, while it is definitely disposable:

```bash
aws ec2 terminate-instances --instance-ids <new-id> --dry-run
```

Expect `DryRunOperation`. This is the positive control: P1 proved termination is
denied for **production**; P3 proves it is permitted for a **run-owned** instance.
Together they show the deny is scoped, not blanket.

## 9. Inventory reporting

Reported in the PR after launch and again after teardown:

* instance ID, state, launch time, AZ, public IP
* volume ID(s), size, type, `DeleteOnTermination`
* security group ID and inbound rules
* AMI, instance type, CPU credit mode
* generator location and pinned commit
* measured cost before and after

## 10. Teardown approval procedure

1. export evidence first — teardown is never blocked by export failure, but
   evidence is fetched before the instance disappears
2. **stop and request approval naming the exact instance ID**
3. on approval: `terminate-instances` for that ID only
4. poll to state `terminated`
5. confirm the root EBS volume is deleted
6. confirm the public IPv4 is released
7. run the sweep in section 5 and report all three counts
8. delete the run security group last
9. report final inventory and cost

Termination targets one pinned instance ID. No filter-based mass termination is
used, so an error cannot reach anything else.

---

## 11. Approval boundary for this checkpoint

**Nothing has been launched.** At this checkpoint the following are all NOT done
and each requires separate approval:

| Action | Status |
|--------|--------|
| launch the instance | **not done** |
| change ingress on `sg-012a0191f4e4a9a8c` | **not done** — inbound still empty |
| run any load test | **not done** |
| terminate anything | **not done** |
| create a volume | **not done** |
| modify production | **never** |

### Pinned versions

| Item | Pinned to |
|------|-----------|
| Repository commit | the PR head SHA named in the approval request |
| CI-tested SHA | recorded with the confirmation request; launch pins exactly that commit |
| AMI | `ami-01e91e94accc42eec` |
| Instance type | `t3.micro`, `CpuCredits=standard` |
| Region / AZ | `ap-southeast-2` / `ap-southeast-2b` |
| Subnet | `subnet-01f25dc99e013aa6a` |
| Security group | `sg-012a0191f4e4a9a8c` (existing, inbound empty) |
| Key pair | none |

The AMI is pinned by ID. A different AMI is a different run and is not covered by
this approval.

### Remaining blockers before launch

1. **Budget notification email** — needed to create the notification-only budget.
   Budgets supports `SubscriptionType=EMAIL` directly; no SNS topic is required
   and no IAM change is needed.
2. **Ingress approval** — the CIDR decision in section 7 (GitHub ranges, or a
   single known egress `/32`).
3. **Instance launch approval** — naming the pinned instance ID that teardown
   will later target.
