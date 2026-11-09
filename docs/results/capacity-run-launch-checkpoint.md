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
| gp3 30 GB | $0.096/GB-month × 30 GB × (4 h ÷ 730 h) | **$0.0158** |
| Public IPv4 | $0.005/h | $0.0200 |
| **Sum of the above** | | **$0.0886** |

The gp3 figure was previously shown as $0.0132 — the cost of ~13.7 GB, not 30.

### These are partial estimates, not worst-case charges

$0.0886 (4 h) and $0.0997 (4.5 h) cover only the three lines above. **Not
included**, because they are not priced here and some are not knowable in advance:

* **Data transfer out** — the load test's response bytes to the generator. Not
  zero, and the largest omission. A few hundred MB at Sydney egress rates would
  exceed the compute line.
* **Data transfer in** — normally free, assumed free here.
* **EBS I/O — gp3 does not bill per operation.** It includes 3,000 IOPS and
  125 MB/s baseline. Charges arise only from *provisioning* IOPS or throughput
  **above** that baseline, which is billed per provisioned IOPS-month, not per
  operation. This run provisions none, so the extra charge is $0 — but that is
  a statement about provisioning, not about usage being free of consequence.
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

### A guest shutdown alone would leak billable storage

`InstanceInitiatedShutdownBehavior` accepts only `stop` or `terminate`, and the
**default is `stop`**. A plain `shutdown -h now` therefore stops the instance:
compute billing pauses, the **EBS volume keeps billing**. This is the trap in
"schedule a shutdown timer" — stopping is not cleaning up.

The launch therefore sets **both** `--instance-initiated-shutdown-behavior terminate`
and `DeleteOnTermination=true`, and both are read back afterwards (section 6) rather
than assumed from the request.

### The deadline is measured from launch time, not from bootstrap

This is the correction that matters most. Arming a timer with `--on-active=4h`
*whenever bootstrap happens to finish* means a bootstrap that takes 40 minutes buys
the run 4h40m. `infra/capacity-run/user-data.sh` instead reads the instance's own
launch time from IMDS and computes:

```
remaining = launch_epoch + 14400 - now
```

and arms the timer for `remaining`. A slow bootstrap shortens what is left; it
never extends the window. If the remaining time is already ≤ 0 the bootstrap
**terminates rather than lingering**, and if the launch time cannot be read it
fails closed rather than falling back to `now`.

### The guest deadline and reboot

An earlier draft of this document claimed user-data runs on every boot and re-arms
the timer. **That was false.** EC2 user-data runs **once**, on first boot. A
`systemd-run --on-active` timer would have been transient and lost on reboot, and
nothing would have re-armed it.

What is implemented instead: the bootstrap installs a **persistent** unit,
`capacity-deadline.timer` (`WantedBy=timers.target`), which `systemctl enable`
starts on every subsequent boot. The guard it runs compares the current time
against the **absolute** `DEADLINE_EPOCH` recorded at bootstrap, so a reboot
neither extends nor resets the window. Deadline files live under
`/var/lib/assetflow-capacity/evidence`, which survives a reboot.

**Limitation, stated rather than hidden:** this is proven by *static* tests only —
they assert the unit is persistent, enabled, and that the guard uses an absolute
deadline and calls shutdown. **A real reboot has not been performed and is not
claimed to have been tested.** Proving it needs a live instance, which needs the
launch approval below. Until then the claim is "correct by construction and
covered by static tests", not "verified on a rebooted host". The operator watchdog
is the independent second path for exactly that reason.

### The operator watchdog is a real artifact, not a sleep snippet

`infra/capacity-run/operator-watchdog.sh`. It is not `sleep 4h && terminate`:

| Property | Why |
|----------|-----|
| `setsid nohup` detached | survives the operator closing the terminal or the editor session |
| heartbeat file + pid file | liveness is **observable**, not assumed |
| re-derives deadline from `LaunchTime` each cycle | a missed cycle or clock skew cannot extend the run |
| refuses to act if `RunId` tag does not match | the ID could be reused or retagged |
| treats `terminated`/`shutting-down` as success | no error, no double-terminate |
| does **not** terminate on an unreadable state | an API error is not consent to act |

Verified behaviourally, not by inspection — 8 tests drive the real script against a
fake `aws`, and the RunId-guard test was confirmed to **fail** when the guard is
removed:

| Scenario | Expected | Result |
|----------|----------|--------|
| launched 5 h ago, lifetime 4 h | terminate | terminates |
| already `terminated` | exit quietly | exits, no second call |
| `RunId` does not match | refuse | refuses every cycle, no call |
| launched now | leave alone | no call |
| state unreadable | retry, do not act | no call |
| — | heartbeat + pid written | both present |

**P3 proves termination is authorized. It does not prove a scheduler runs.** Those
are different claims and only the tests above speak to the second.

## 5. Leftover billable storage and the inventory sweep

`infra/capacity-run/inventory-sweep.sh` is the authoritative sweep. Two defects in
the earlier documented loop are fixed there:

| Defect | Consequence | Fix |
|--------|-------------|-----|
| `length(Reservations)` used for **volumes** | `describe-volumes` has no `Reservations` member, so the volume count was an error printed as a number | each call names its own array: `Reservations` / `Volumes` / `SecurityGroups` / `Addresses` |
| errors hidden by `2>/dev/null \|\| echo 0` | a denied or failed call was indistinguishable from "no resources" — this is exactly how a security group was earlier reported absent while it existed | any AWS error aborts with a non-zero exit and prints the error |

Terminated instances are **excluded from the active count**. They keep their tags
for a while after termination, so filtering by tag alone would overcount.

Live output at this checkpoint:

```
run-owned resources for cap-20261109t0800z-a7f3
  instances active     : 0
  instances terminated : 0   (tagged, not billed for compute)
  volumes              : 0
  security groups      : 1
  elastic/public IPv4  : 0
```

Verified that a failing call no longer reports zero — with a bad profile the sweep
prints `FATAL: cannot authenticate; refusing to report counts` and exits non-zero,
rather than printing `0`.

After teardown the expectation is a hard zero for active instances, volumes,
security groups and addresses.

## 6. Readiness, over HTTPS only

There is no SSH and no SSM. A file inside an unreachable guest is not evidence, so
every readiness signal is served by the evidence endpoint and read by
`infra/capacity-run/readiness-check.sh`.

### Trust provisioning: generated locally, no S3

The capacity identity has an **explicit `Deny` on `s3:*`** (verified: `aws s3 ls`
returns `AccessDenied`, "explicit deny"), and the guest has **no instance role**.
Publishing trust material to S3 would therefore have required a new bucket and new
permissions. It is generated locally instead by
`infra/capacity-run/generate-trust.sh`:

| Artifact | Where it lives | Why |
|---|---|---|
| `tls.crt` | operator dir **and** rendered user-data | client verifies, guest serves |
| `tls.key` | operator dir **and** rendered user-data | guest only |
| `evidence.token` | operator dir **and** rendered user-data | both sides must match |

No bucket, no instance role, no new AWS credentials. The guest receives this
through the **existing** rendered provisioning path (`render-user-data.sh`), which
refuses to embed `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or
`AWS_SESSION_TOKEN` (exit 3).

### The certificate is bound to a name, not to an address

The instance's public IPv4 is unknown until after launch, so a certificate bound to
it could not be generated in advance. The certificate therefore carries a fixed
**DNS SAN**: `capacity-run.test`. The client connects to the real address while
verifying that certified name:

```bash
curl --cacert tls.crt --resolve capacity-run.test:8443:<instance-ip> \
     https://capacity-run.test:8443/evidence/snapshot-latest.tar.gz
```

`--resolve` and `--cacert` together keep **both** CA verification and hostname
verification intact. `-k` and `--insecure` are never used, and a test asserts no
client script contains them.

### EC2 user-data is not a secret store

The TLS key and token are embedded in user-data. That is **not encryption** —
base64 is an encoding. User-data is stored by AWS, readable by any principal with
`ec2:DescribeInstanceAttribute` on the instance, and readable by any root process
on the guest. This is acceptable only because the material is short-lived
(2-day certificate) and run-scoped, and because no production secret and no AWS
credential is placed there. Do not reuse this pattern for anything durable.

### Read-back corrections

`InstanceInitiatedShutdownBehavior` **is not returned by `describe-instances`**.
Verified against the live API: the query returns `None`. The correct read is:

```bash
aws ec2 describe-instance-attribute \
  --instance-id <id> --attribute instanceInitiatedShutdownBehavior
```

That call requires `ec2:DescribeInstanceAttribute`, which the policy did **not**
grant — verified: the call fails with `no identity-based policy allows the
ec2:DescribeInstanceAttribute action`. The fix is that one read permission, added
to the existing read statement. No write permission was added; a test asserts this.

### Checks, in order

| # | Check | Source | Fails when |
|---|-------|--------|------------|
| 1 | instance `running`, status `2/2` | `describe-instances`, `describe-instance-status` | not running |
| 2 | shutdown behaviour = `terminate` | `describe-instance-attribute` | reads `stop` |
| 3 | `DeleteOnTermination = true` | `describe-instances` block device mappings | false |
| 4 | bootstrap status = `ready` | evidence endpoint `/bootstrap-status` | `degraded`, `running`, unreachable |
| 5 | deadline armed | `/timer-state` + `/deadline-epoch` | not `active`, or no future epoch |
| 6 | deployed commit matches the pin | `/deployed-commit` | mismatch |
| 7 | RSS ≤ 70% of 1024 MB | `/host-metrics.jsonl` last line | over gate |
| 8 | Nginx limiter unchanged | app config over 8443 | different parameters |
| 9 | baseline spend | `ce:GetCostAndUsage`, read ONCE | — |

Step 4 `degraded` means the secret channel was absent, so the app never started.
That is a failure, not a pass with a warning.

### What readiness cannot claim

`readiness-check.sh` prints this itself: **it proves the timer unit is active now,
not that it will fire.** An active unit can still be masked later, crash, or be
cleared by a reboot. That is why the operator watchdog exists as an independent
second line, and why the guard against overrun is the watchdog plus the
launch-based deadline, not the timer alone.

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

The returned address is then allowed as `<EGRESS_IP>/32` on 8443 (the evidence
endpoint; the app itself is exercised through the load generator, not over ingress).

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

Only 8443, only exact discovered addresses:

| Type | Protocol | Port | Source | Purpose |
|------|----------|------|--------|---------|
| Ingress | tcp | 8443 | `<GENERATOR_EGRESS_IP>/32` | readiness + evidence |
| Ingress | tcp | 8443 | `<EVIDENCE_EGRESS_IP>/32` | evidence download (only if different) |
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

One request covering three coupled changes. Until it is approved, none happen.

### 12.1 Artifacts and the pinned commit

| Artifact | Path | Shellcheck | Tests |
|----------|------|-----------|-------|
| Bootstrap (user-data) | `infra/capacity-run/user-data.sh` | clean | 6 contract tests |
| Metrics collector | `infra/capacity-run/collect-metrics.sh` | clean | — |
| Operator watchdog | `infra/capacity-run/operator-watchdog.sh` | clean | 8 behavioural tests |
| Readiness check | `infra/capacity-run/readiness-check.sh` | clean | 3 contract tests |
| Inventory sweep | `infra/capacity-run/inventory-sweep.sh` | clean | exercised live |

`infra/tests/test_capacity_run_bootstrap.py`: **16 tests**, which execute the real
watchdog against a fake `aws`. The RunId-guard test was confirmed to fail when the
guard is removed, so the tests are not vacuous. These artifacts are **in the
repository**, not local-only.

**CI-tested commit: `32e9bd2`** — run `42624039643`, all seven jobs success,
including a new capacity-stack job that deploys the real compose stack. This is the
commit the launch pins.

That job is the evidence for the bootstrap defects found in review. It builds the
real images, runs real migrations, seeds 200 accounts, proves the count by querying
Postgres, starts the API and confirms 4000/api/health/ready, calls the application
over HTTPS through the single-port edge, runs readiness and a checksum-verified
export as a client, and drives real systemd timer activations.

Earlier pins and why they are superseded: `66c5589` (run `42608467206`) covered the
bootstrap/readiness fixes but still published trust to S3, which the identity
denies. `6533edf` (run `42604425610`) passed but covered the application only and
predated these artifacts entirely.

### 12.2 Ingress — 8443 only, exact discovered `/32`

| Type | Proto | Port | Source |
|------|-------|------|--------|
| Ingress | tcp | 8443 | `<GENERATOR_EGRESS_IP>/32` from discovery inside the generator job |
| Ingress | tcp | 8443 | `<EVIDENCE_EGRESS_IP>/32` only if the evidence job is a different job |
| Ingress | tcp | 22 | **none** — no key pair is attached |

No published GitHub ranges, no `0.0.0.0/0`, no port ranges. If the egress cannot be
pinned the run reports that and stops.

### 12.3 One disposable instance

`t3.micro` in `ap-southeast-2b`, Standard credits, AMI `ami-01e91e94accc42eec`,
`--instance-initiated-shutdown-behavior terminate`, root gp3 30 GB with
`DeleteOnTermination=true`, tagged `Project=assetflow-capacity` /
`RunId=cap-20261109t0800z-a7f3`, using the existing `sg-012a0191f4e4a9a8c`.

### 12.4 What approving this launch also approves

* **Automatic deadline termination.** The instance terminates itself at
  **launch + 4 h** via the in-guest timer, deleting its volume. That is intended
  behaviour.
* **Readiness-failure cleanup.** If any readiness check fails, including a missing
  timer marker, the instance is terminated **without** a further approval request,
  because leaving a host up to pollute the run is worse than tearing it down.
* **Operator watchdog** termination of the same instance ID at the same deadline.

Routine early teardown still follows the exact-instance approval procedure
(section 10): a human names the instance and approves.

### 12.5 The deadline does not rest on the timer alone

Stated plainly, because it was a review finding: a timer marker does not guarantee
termination. Three independent paths exist — in-guest timer, operator watchdog, and
manual teardown — and the run reports which one acted.

### 12.6 Cost

| Item | 4 h |
|------|-----|
| t3.micro | $0.0528 |
| gp3 30 GB | **$0.0158** |
| public IPv4 | $0.0200 |
| **Sum** | **$0.0886** |

Excludes data transfer out (the largest omission), provisioned IOPS above the gp3
baseline, and other AWS API calls. `ce:GetCostAndUsage` is read **once** before and
**once** after the run, not polled: each call is billed, so repeated polling would
add cost to a run intended to measure cost.

### 12.7 What this request does NOT cover

* load testing — separate, after readiness passes
* terminating a specific instance early — requested separately by exact ID
* any production change, SNS resource, or budget action


---

## 13. Stage 2 handoff — read-only reconciliation at close

Date of reconciliation run: see commit. No resources were created, changed or
terminated for this section.

### 13.1 Tested SHA and CI evidence

| Item | Value |
|---|---|
| Tested SHA | `32e9bd2a8d3365f701764d1ba21a73725803ca64` |
| CI run | `42624039643` — **all seven jobs success** |
| Deployment evidence | `capacity-stack` job: real compose build, migrations, seeding 200 accounts, database-count proof, `4000/api/health/ready` readiness, HTTPS application path through the single-port edge, client-side readiness + checksum-verified export, real systemd repeated timer activation |

Commits after the tested SHA at the time of this handoff: **one**, `c54004b`
("Pin the launch to 32e9bd2"), which changes **only**
`docs/results/capacity-run-launch-checkpoint.md`. It does not touch any executable
launch artifact, so the tested SHA remains the launch pin. Branch tip is **not**
silently substituted for the tested SHA.

### 13.2 What the CI run proved, and what it did not

Proved on GitHub-hosted CI hardware (much more RAM than the target):
real compose build, real migrations, real seeding with a 200-account fixture
verified by a `SELECT count(*)` on Postgres for the run's own prefix, the
application's real readiness route, the HTTPS application path through the
single-port edge, readiness and a checksum-verified export from the client side,
and genuinely repeated systemd timer activations of the deadline guard (five with
the fix, one with `RemainAfterExit=yes` as the control).

NOT tested anywhere yet: the behaviour of a 1 GiB t3.micro (image build pressure,
swap usage, credit behaviour), real EC2 launch and IMDS, real ingress `/32`, and
survival of the deadline timer across a **real reboot**. Those belong to Stage 3
and remain explicitly untested rather than assumed.

### 13.3 Launch package (operator sequence, exact artifacts)

All paths relative to the repository at the tested SHA. Nothing here embeds or
prints secrets; rendered user-data is never committed.

1. **Isolated application configuration** — the compose file has no defaults for
   `POSTGRES_PASSWORD` / `REDIS_PASSWORD`; the API requires a unique `JWT_SECRET`
   >= 32 chars; the seed refuses more than one account without `LOADTEST_PASSWORD`
   (40 chars). Generate all of them per run:
   ```bash
   ./infra/capacity-run/generate-app-config.sh .capacity-app.env cap-20261109t0800z-a7f3
   ```
2. **Trust material** — certificate (EC P-256, DNS SAN `capacity-run.test`, no
   IP SAN because the address is unknown before launch), key and bearer token:
   ```bash
   ./infra/capacity-run/generate-trust.sh .capacity-run-trust
   ```
3. **Render user-data with the correct encoding and size check** — the renderer
   base64-encodes the payload for the EC2 API, embeds the trust material, the app
   config and the deadline guard, strips comments, and must stay under the EC2 raw
   16 KiB limit (currently ~13.9 KiB):
   ```bash
   set -a; . .capacity-app.env; . .capacity-run-trust/trust.env; set +a
   LAUNCH_EPOCH=$(date +%s) \
   EXPECTED_COMMIT=32e9bd2a8d3365f701764d1ba21a73725803ca64 \
   RUN_ID=cap-20261109t0800z-a7f3 \
   ./infra/capacity-run/render-user-data.sh > user-data.b64
   base64 -d user-data.b64 | wc -c   # must be <= 16384
   ```
   The CLI encoding path: `aws ec2 run-instances --user-data file://user-data.raw`
   where `user-data.raw` is the **decoded** script. Passing the base64 text to the
   CLI would double-encode, which is why the render output is decoded to disk
   first.
4. **Discover the generator job's public IPv4 inside the job** — the only
   supported source, since published range lists do not match:
   ```bash
   curl -fsS https://checkip.amazonaws.com/
   ```
5. **Keep that same runner alive** for the approved launch and readiness sequence —
   discovery, authorizing, launching and readiness must all run in one job so the
   source address cannot change mid-run.
6. **Apply only the proposed rule** from that exact `/32`:
   ```bash
   aws ec2 authorize-security-group-ingress --group-id sg-012a0191f4e4a9a8c \
     --protocol tcp --port 8443 --cidr <EGRESS_IP>/32
   ```
   Nothing else. No port 22, no `0.0.0.0/0`.
7. **Launch exactly one instance pinned to the tested commit** — user-data carries
   `EXPECTED_COMMIT=32e9bd2a8d3365f701764d1ba21a73725803ca64`; the bootstrap clones
   the repo, checks out that exact SHA, verifies `rev-parse HEAD`, and refuses to
   proceed on mismatch. Launch config in section 2 and the Stage 3 request.
8. **Start and verify the detached operator watchdog**:
   ```bash
   setsid nohup ./infra/capacity-run/operator-watchdog.sh <instance-id> 14400 \
     >> watchdog.log 2>&1 &
   ```
   It writes `pid` and a `heartbeat` file each cycle, re-derives the deadline from
   the instance's actual `LaunchTime` via the EC2 API (never from a stored value),
   refuses to act on an instance whose RunId tag does not match the run, and only
   terminates when the launch-based deadline is reached.
9. **Immediate P3, inventory and authenticated TLS readiness** — `run-instances
   --dry-run` against the returned ID, then the inventory sweep
   (`infra/capacity-run/inventory-sweep.sh`), then
   `infra/capacity-run/readiness-check.sh <public-ip> 8443` with
   `EVIDENCE_CA`, `EVIDENCE_TOKEN`, `CAPACITY_HOSTNAME=capacity-run.test` set. The
   client connects to the real address while verifying the certified name
   (`--resolve`); no `-k`.

### 13.4 Verified AWS state at handoff (resource-specific queries)

All queries used the `capacity` profile; errors are reported, never zeroed.

| Check | Result | Notes |
|---|---|---|
| Caller / account | `arn:aws:iam::459252806274:user/assetflow-capacity-run` | `sts get-caller-identity` |
| Region | `ap-southeast-2` | desc. instances returns Sydney |
| Run-owned instances (any state) | **0** | `describe-instances` filter tag:RunId, exit 0 |
| Run-owned volumes | **0** | `describe-volumes` filter tag:RunId, exit 0 |
| Expected SG | `sg-012a0191f4e4a9a8c` `cap-20261109t0800z-a7f3-sg` | exists |
|  — VPC | `vpc-0bcfe8d7f2e811bb3` | matches run VPC |
|  — tags | `Name=assetflow-capacity-sg`, `Project=assetflow-capacity`, `RunId=cap-20261109t0800z-a7f3` | verified |
|  — inbound | **0 rules** | `length(IpPermissions)` = 0 |
| Run-tagged SGs | exactly 1 | no extras |
| Run-tagged EIPs | 0 | `describe-addresses` |
| Budget | `cap-20261109t0800z-a7f3`, COST USD 1.00, MONTHLY | |
|  — notification | ACTUAL GREATER_THAN 80%, 1 EMAIL subscriber, address redacted | |
|  — delivery | **configured only, not delivery-verified** | a delayed alert, not a cap |
|  — actions | none (account-wide query, exit 0) | per-budget call is denied by policy; this is a permission boundary, not a zero |
|  — health | HEALTHY, actual spend $0.00 | |
| Production | `i-0ff4690ec52d0dc01` running, t3.micro, ap-southeast-2b | read-only |

### 13.5 Lifecycle and cost, recorded

* Guest deadline: absolute `LAUNCH_EPOCH + 14400`, provisioned by the operator at
  render time (the launch instant is the only correct anchor; IMDS does not expose
  it). The guard validates the whole value (no digit-stripping), fails closed, and
  shuts the guest down, which terminates the instance because of _terminate_
  behaviour, deleting the root volume (DeleteOnTermination=true).
* Operator watchdog deadline: re-derived every cycle from the returned instance's
  actual `LaunchTime` + 4 h. Independent of the guest.
* Timer polling delay: `OnUnitActiveSec=60s` means enforcement can lag the
  deadline by up to ~60 s between ticks; the watchdog polls the EC2 API on its own
  interval and is the tighter bound of the two. A reboot would re-arm the timer
  from the same absolute deadline, but a real reboot has not been performed and is
  not claimed to have been tested.
* Four-hour termination and readiness-failure cleanup are both part of the Stage 3
  request (self-termination + teardown if readiness fails).
* Partial cost estimate and exclusions (section 3): gp3 30 GB / ~4 h
  ~$0.0158; instance ~$0.0728; total ~$0.0886; **excludes** data transfer out,
  provisioned IOPS/throughput above baseline, and any build/retry spill. `$1` is
  the notification threshold, `$5` is the monitoring tripwire; **neither is a hard
  spending cap** — nothing enforces cost, so the 4-hour lifetime and the operator
  are the real limits.


---

## 14. Stage 3 execution — FAILED at readiness

Executed under approval, pinned to
`32e9bd2a8d3365f701764d1ba21a73725803ca64`. **Outcome: FAIL.** The instance launched
correctly, P3 passed, and the shutdown guards worked — but the application never
became reachable and the guest terminated itself under the fail-closed path.

### 14.1 Result summary

| Item | Result |
|---|---|
| Instance launched | **yes** — `i-02611b7898dca0bc7`, running at verification time |
| P3 termination dry-run | **PASS** — `DryRunOperation` on the returned ID |
| Account / tags / type / AZ / AMI / subnet / SG | **PASS** |
| Root volume size | **FAIL — 8 GB, not the approved 30 GB** (see 14.3) |
| Shutdown-behaviour readback | **BLOCKED** — `ec2:DescribeInstanceAttribute` denied |
| CPU credit readback | **BLOCKED** — `ec2:DescribeInstanceCreditSpecifications` denied |
| TCP/8443 reachable | **never** — 60+ probes over ~52 min, all connection failures |
| TLS authentication | **not reached** |
| Application readiness | **not reached** |
| 200 fixture accounts | **not reached** |
| Evidence export | **not reached** |
| Host metrics / deadline status | **not reached** |
| Volume deleted on terminate | **PASS** — `vol-04fc9bf830960fb41` no longer exists |
| Production unaffected | **PASS** — still running |

### 14.2 Timeline (UTC)

| Time | Event |
|---|---|
| 13:20:20 | first launch dry-run denied: `ec2:RunInstances` on `network-interface/*` |
| 13:26:13 | dry-run passes after tagging the network interface |
| **13:34:49** | instance launched, `ap-southeast-2b` |
| 13:34:49 | P3 termination `--dry-run` returns `DryRunOperation` |
| 13:37:22 | first TCP/8443 probe: connection failure |
| 13:37-14:26 | 60+ readiness probes, every one failed |
| 14:26:39 | last probe, still no listener; `openssl s_client` got no handshake |
| ~14:26-14:33 | instance terminated itself, `Client.InstanceInitiatedShutdown` |

### 14.3 Defects found in the launch procedure (not in the code)

1. **The first dry-run was denied because the network interface was untagged.** Policy
   statement `08LaunchNetworkInterfaceTagControlled` allows
   `network-interface/*` only with `aws:RequestTag/RunId`, and my launch tagged only
   the instance and volume. **Fixed during the run** by adding a
   `ResourceType=network-interface` tag specification. This is an operator error in
   the launch command, and the audit trail above keeps it.
2. **The root volume came out at 8 GB instead of the approved 30 GB.** The AMI's
   root mapping is 8 GB and I passed no block-device mapping, so the AMI default was
   used. The approved configuration says 30 GB gp3. This instance therefore did **not**
   match the approved configuration, which alone is enough to fail the run. The
   correct fix is a `--block-device-mappings` entry with
   `DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}`.
   *Note the direction of the deviation: it was smaller and cheaper than approved.*

### 14.4 What caused the stop

The deadline guard was **correctly configured** and did **not** fire early: the
payload carried `LAUNCH_EPOCH=1794231251`, giving a deadline of **17:34:11Z**, and
the instance died between 14:26:39Z and 14:33Z — roughly three hours before it.
`StateTransitionReason` was `Client.InstanceInitiatedShutdown`, the signature of the
bootstrap's own fail-closed shutdown combined with
`InstanceInitiatedShutdownBehavior=terminate`.

So the safety mechanism worked exactly as designed: when the bootstrap could not
reach a working state, it terminated rather than leaving a broken, billing instance
running. That is the intended behaviour and it is a point in favour of the design.

**What is not proven is *which stage* failed.** No SSH, no SSM, and no
`ec2:GetConsoleOutput` permission, so neither the journal nor the serial console was
readable after termination. The absence of any listener on 8443 plus the fail-closed
signature points to a failure at or before the image build/start stage on a 1 GiB
t3.micro, most plausibly memory pressure during the compose build and start, but
**this is inference, not evidence**, and is labelled as such.

### 14.5 Verified clean-up and current state

| Resource | State |
|---|---|
| Run-owned instances | **0** |
| Run-owned volumes | **0** (root volume deleted on terminate — verified by absence) |
| Run-owned elastic IPs | **0** |
| Run-owned security group | **1**, `sg-012a0191f4e4a9a8c`, inbound 1 rule `tcp/8443` from `157.48.109.250/32` |
| Production | `i-0ff4690ec52d0dc01` running |
| Budget | unchanged, notification-only, no actions |

The ingress rule is deliberately left in place because removing it was not approved;
it is inert with no instance in the group, and its removal needs its own approval.

### 14.6 Required before Stage 4

1. **Diagnose the bootstrap failure with evidence**, not inference. Either grant
   `ec2:GetConsoleOutput` and `ec2:DescribeInstanceAttribute` for the run, or have the
   bootstrap write its stage log somewhere durable and readable, or accept that the
   first order of business on the next launch is capturing the guest log.
2. **Decide whether t3.micro is the right size for this stack.** A 1 GiB instance
   building and running 14 containers is the dominant risk; the CI evidence was
   collected on far larger hardware and cannot vouch for it.
3. **Fix the launch command**: add the network-interface tag specification and the
   explicit 30 GB gp3 block-device mapping.
4. **Grant readback permissions** for shutdown behaviour and credit specification so
   the approved configuration checks can actually be performed.

None of these are load-testing questions; Stage 4 needs a stack that starts at all.

---

## 15. Stage 3 post-mortem and corrections

### 15.1 Proven root cause: disk exhaustion

The system log shows the image build reaching `npm ci`, Prisma generation and Nest
compilation, then the export failing:

```
failed to write compressed diff
no space left on device
```

and journald reporting `Failed to create new system journal: No space left on
device`, followed by `[bootstrap][FATAL] migration failed`.

Two things follow. The root volume was **8 GB, not the approved 30 GB**, because the
launch command passed no block device mapping and the AMI default applied. And the
bootstrap's `FATAL migration failed` label is **broader than the failure** — no SQL
migration of ours failed; the disk was full.

The npm deprecation and audit warnings in the same log are **not** the cause and are
not treated as such.

### 15.2 Correction to section 14.4

Section 14.4 said the safety mechanics worked. That was too generous:

* the **deadline service genuinely failed**, repeatedly, while the build ran;
* the **operator watchdog never started** — it was prepared but the run never got there.

What did work: the fail-closed shutdown fired, and
`InstanceInitiatedShutdownBehavior=terminate` ended the instance and deleted the volume.

### 15.3 Deadline service: unresolved, and why it is not simply "a failed unit"

The guard's logic was tested directly in real systemd and is sound: five genuine
timer activations, silence before the deadline, fail-closed on malformed and on
unreadable deadlines, tolerance of a read-only evidence directory, and every exit path
returning 0. `RemainAfterExit=yes` was confirmed to block re-activation, which is the
defect the current shape avoids.

The remaining hypothesis — systemd unable to journal while the disk was full — is
**plausible but unproven**. The generic "Failed to start" text is not evidence for it.

Mitigation, since journald could not be the record: `deadline-guard.sh` now writes to
`/dev/console` as well as stdout, and logs its deadline file, the value and the current
time on every invocation. That survives a full disk and lands in the EC2 system log.

### 15.4 Corrections made

| Change | Why |
|---|---|
| `launch-instance.sh` | One launcher replaces the hand-reconstructed command. Tags instance, volume **and network interface**; resolves the root device from the AMI and requests 30 GB gp3 explicitly with `DeleteOnTermination=true`; requires a client token and reconciles an uncertain response instead of retrying; refuses to duplicate an instance; rejects an oversized payload before any AWS call. |
| Disk preflight in `user-data.sh` | Free space checked before any build work, 12 000 MB floor, recorded to evidence, fails closed if `df` cannot be read. An undersized volume is now reported as an undersized volume while there is room to report it. |
| Console diagnostics in `deadline-guard.sh` | journald died of ENOSPC; `/dev/console` is independent of root-volume free space. |
| 13 new contract tests | Fault-injected: removing the network-interface tag or the block device mapping makes them fail. |

### 15.5 Rehearsal actually executed

The real deployment path was rehearsed on CI hardware, not merely reasoned about:
compose build, real migrations, seeding 200 accounts, **200 accounts proven by a
database count**, the API readiness route, the HTTPS application path through the
single-port edge, client-side readiness, a checksum-verified export, and genuine
repeated systemd timer activation.

Differences from EC2, stated plainly: CI has far more RAM than a 1 GiB t3.micro, its
disk is not the 30 GB gp3 volume, and there is no real ingress or IMDS. The rehearsal
proves the *procedure*, not the *hardware's* fitness. Peak disk usage on a real t3.micro
remains **unmeasured**, so 30 GB is justified by arithmetic and the failure margin, not
by observation.

Real reboot survival of the deadline timer remains **untested**.

### 15.6 Read permissions

The run was denied `ec2:GetConsoleOutput`, `ec2:DescribeInstanceAttribute` and
`ec2:DescribeInstanceCreditSpecifications`. `DescribeInstanceAttribute` *appears*
allowed in the local policy document, but the deployed policy cannot be read by this
identity (IAM self-inspection is explicitly denied), so the deployed content is
**unverified** and the local file must not be assumed to match it. A minimal
read-only policy is provided as `docs/results/capacity-run-stage3-read-policy.json`,
scoped to three actions in `ap-southeast-2`, to be attached in the console as its own
customer-managed policy rather than appended to the nearly-full Stage 2 policy.
