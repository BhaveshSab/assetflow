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

## 7. Access — exact /32 sources, discovered not assumed

**Current state: inbound is empty.** The group has no inbound rules and none are
added at this checkpoint.

Two clients must reach the instance over HTTPS. Neither has a predictable address,
so the plan is to **discover each address from inside the job that uses it**, then
propose a `/32` for exactly that address — not the published GitHub ranges, which
would admit every GitHub runner in the world.

### 7.1 Discover the generator's egress address

Run this as the **first step of the same job** that will perform the load test, and
keep that job alive for readiness and the whole test:

```bash
EGRESS_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '\r\n')"
echo "generator egress: ${EGRESS_IP}"
```

The returned address is then allowed as `<EGRESS_IP>/32` on 443.

**Critically: the same job must do discovery, readiness and the load test.** A
different job gets a different runner and therefore a different egress address, so
a rule derived in one job would not admit the next one. Keeping one job alive for
the entire sequence is what makes the `/32` rule valid.

### 7.2 Discover the evidence client's egress address

The evidence download is a separate step and may run in a different job, hence a
different address. Discover it the same way, inside that job:

```bash
EVIDENCE_IP="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '\r\n')"
echo "evidence egress: ${EVIDENCE_IP}"
```

If the same job does both, one `/32` covers both; do not assume that, check it.

### 7.3 Proposed rules

Only 443, only exact discovered addresses:

| Type | Protocol | Port | Source | Purpose |
|------|----------|------|--------|---------|
| Ingress | tcp | 443 | `<GENERATOR_EGRESS_IP>/32` | load generator + readiness |
| Ingress | tcp | 443 | `<EVIDENCE_EGRESS_IP>/32` | evidence download (only if different) |
| Ingress | tcp | 22 | — | **none**: no key pair is attached, so SSH is impossible |

Two rules at most. No port ranges, no `0.0.0.0/0`, no published range lists.

### 7.4 The limitation, stated plainly

**A `/32` learned from a GitHub-hosted runner cannot be known in advance.** It
depends on which runner the job lands on. This creates two real constraints:

1. **The rule must be added after discovery but before the test**, which means a
   human or scripted step between them — not a fully hands-off sequence.
2. **If the job is re-run, the address may change** and the existing rule will not
   admit it. The re-run will fail to connect, which looks like a broken app but is
   really a stale firewall rule.

If the egress address cannot be pinned reliably — for example if discovery returns
an address that the job cannot keep, or the runner is replaced mid-test — then the
rule set is not trustworthy for a `/32` approach. **In that case the correct
outcome is to report the limitation and stop**, not to widen to the published
GitHub ranges or to `0.0.0.0/0`. A broader rule would admit arbitrary GitHub
tenants to a host running a load test, which is a much larger exposure than the
one it fixes.

Narrowing further is also acceptable: if you have a host with a known static
egress IP, run the generator and evidence client from it and allow only that
`/32`. That is the tightest option and removes the discovery step entirely.

The evidence endpoint also requires a bearer token over TLS, so the CIDR is
defence in depth rather than the only control.

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

1. **Ingress approval** — the discovery step in section 7 must run first, because
   the `/32` addresses cannot be known until the jobs report them. Approving the
   *rule shape* now is possible; the concrete addresses come from discovery.
2. **Launch approval** — the consolidated request below.

### A note on identifying the instance

The instance ID **cannot be named before launch**; AWS assigns it. So the launch
approval identifies the run by its **exact configuration and run tags** instead:

| Identifier | Value |
|------------|-------|
| Tag `RunId` | `cap-20261109t0800z-a7f3` |
| Tag `Project` | `assetflow-capacity` |
| AMI | `ami-01e91e94accc42eec` |
| Instance type | `t3.micro`, `CpuCredits=standard` |
| Subnet | `subnet-01f25dc99e013aa6a` |
| Security group | `sg-012a0191f4e4a9a8c` |
| Shutdown behaviour | `terminate` |
| Root volume | gp3 30 GB, `DeleteOnTermination=true` |

That tag pair is unique to this run. **After launch the returned instance ID is
reported, and its account, tags and configuration are verified before any teardown
approval is requested** — teardown never proceeds on the assumption that the new ID
is the right instance.

### Scheduled automatic termination — part of this approval

The approval covers a mechanism that **terminates the instance automatically**:

| Mechanism | Detail |
|-----------|--------|
| In-guest timer | user-data schedules `systemd-run --on-active=4h … /sbin/shutdown -h now` at boot |
| What the shutdown does | with `InstanceInitiatedShutdownBehavior=terminate`, the guest shutdown **terminates** the instance and deletes the 30 GB volume |
| Armed-check | user-data writes `/var/lib/capacity-timer-armed`; readiness requires it, and its absence aborts the run |
| Operator watchdog | independent local timer calls `terminate-instances` for the pinned ID at T+4h if the guest timer did not fire |

Approving the launch therefore also approves **this instance terminating itself at
T+4h**. That is intended behaviour, not a failure.

---

## 12. Consolidated approval request

One request covering the three coupled changes. Until it is approved, none of them
happen.

### 12.1 Pinned versions

| Item | Pinned to |
|------|-----------|
| **CI-tested commit** | the SHA whose run is green in PR #31; the launch pins exactly that commit, not the branch tip |
| AMI | `ami-01e91e94accc42eec` (by ID, never "latest") |
| Runtime | Node/dependencies as locked in that commit; no floating tags |
| Load script | `infra/scripts/k6-load.js` at that commit |
| Evidence endpoint | `infra/scripts/evidence_server.py` at that commit |

A branch-tip launch would be untested code; the launched code is the commit the CI
run actually exercised.

### 12.2 Ingress change — 443 only, exact discovered `/32`

| Type | Proto | Port | Source |
|------|-------|------|--------|
| Ingress | tcp | 443 | `<GENERATOR_EGRESS_IP>/32` from discovery in the generator job |
| Ingress | tcp | 443 | `<EVIDENCE_EGRESS_IP>/32` only if the evidence job differs |
| Ingress | tcp | 22 | **none** — no key pair |

No published GitHub ranges, no `0.0.0.0/0`, no port ranges. If discovery cannot
pin the address, the run reports the limitation and does not widen the rule.

### 12.3 One disposable instance

`t3.micro` in `ap-southeast-2b`, Standard credits, AMI and configuration per
section 2, tagged `Project=assetflow-capacity` / `RunId=cap-20261109t0800z-a7f3`,
using the existing `sg-012a0191f4e4a9a8c`. Identified by tag pair and exact
configuration, since AWS assigns the ID at launch.

### 12.4 Lifecycle enforcement included in this approval

Approving the launch approves the instance **terminating itself at T+4h** via the
in-guest timer, with an operator-side watchdog as the independent backup. The
4-hour maximum lifetime is the binding control; the $1 budget is a delayed email
and the $5 target is a manual tripwire.

### 12.5 Cost, restated honestly

| Item | 4 h |
|------|-----|
| t3.micro + gp3 30 GB + public IPv4 | **$0.0886** |
| Not included | data transfer out (largest), EBS I/O over 3,000 IOPS, other AWS API calls |

Total spend will be higher than $0.0886; the size depends mainly on egress, which
this document does not estimate. Nothing technical enforces $5 or $1.

### 12.6 Readiness before any load, in order

1. instance `running`, status checks `2/2`
2. `InstanceInitiatedShutdownBehavior` reads back `terminate`
3. `DeleteOnTermination` reads back `true` for every mapping
4. `/var/lib/capacity-timer-armed` exists → the guest **will** self-terminate;
   absent means abort and terminate immediately
5. `systemctl show capacity-deadline.timer` reports a future elapse
6. memory gate: `sum(RSS) <= 70%` of 1024 MB before the ramp
7. Nginx limiter present and unchanged (`100r/s`, `burst=200`, 429); API throttle
   300/60000 ms
8. HTTPS answers from the generator's discovered address
9. baseline spend read from `ce:GetCostAndUsage`

Then, and only then, P3 (`terminate-instances --dry-run` on the new ID) and the
load test.

### 12.7 What is NOT approved by this request

* load testing — a later, separate step after readiness passes
* termination of a specific instance — requested separately **after** the returned
  ID is verified
* any change to production
* any SNS resource or budget action
