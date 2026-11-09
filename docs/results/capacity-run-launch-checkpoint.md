# Capacity run — final instance-launch checkpoint

Status: **PREPARED, NOT EXECUTED.** Nothing below has been run. No instance, no
volume, no ingress, no load test. Production is untouched.

Pinned code and the pinned AMI are recorded so the run is reproducible from this
document alone.

## 1. Pinned versions

| Item | Pinned value |
|------|--------------|
| Repository commit | `b4f2b1a` (this checkpoint is committed on top; launch pins the commit the PR head names) |
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

```bash
export MSYS_NO_PATHCONV=1
aws ec2 run-instances   --image-id ami-01e91e94accc42eec   --instance-type t3.micro   --subnet-id subnet-01f25dc99e013aa6a   --security-group-ids sg-012a0191f4e4a9a8c   --associate-public-ip-address   --credit-specification CpuCredits=standard   --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}'   --tag-specifications     'ResourceType=instance,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3},{Key=Name,Value=assetflow-capacity-host}]'     'ResourceType=volume,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]'     'ResourceType=network-interface,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]'   --profile capacity --region ap-southeast-2
```

This is the exact request that returned `DryRunOperation` in P2, with `--dry-run`
removed and nothing else changed.

`DeleteOnTermination=true` means the root volume is destroyed with the instance,
so leftover billable storage requires an actual failure of that flag — covered in
section 5.

## 3. Cost

Verified unit prices (`pricing:GetProducts`, Sydney):

| Item | Price | 4 h |
|------|-------|-----|
| t3.micro | $0.0132/h | $0.0528 |
| gp3 30 GB | $0.096/GB-month | $0.0132 |
| Public IPv4 | $0.005/h | $0.0200 |
| **Total** | | **$0.0886** |

Worst case $0.0997. **Proposed ceiling: $5.00** — 50x the estimate, which is
headroom for mistakes, not expected spend. **Maximum lifetime: 4 hours.**

The ceiling and the lifetime bound different things: the ceiling caps money, the
lifetime caps time. A runaway instance at $0.0132/h cannot breach $5 inside 4
hours, so the lifetime is the binding control.

## 4. Lifetime enforcement, independent of the load test

The load test must not be the only thing that ends the run: if it hangs, crashes
or is never started, nothing would stop the clock.

**Primary: an OS-level shutdown timer on the instance itself.** A
`systemd-run --on-active=4h` one-shot unit (or `shutdown -h +240`) is scheduled at
boot, outside the load-test process tree. It survives the generator never
connecting. Because the instance is `--no-key-name`, this is configured via
cloud-init/user-data at launch, not SSH.

**Secondary: an independent watchdog on the operator side** — a separate timer
that runs `terminate-instances` against the pinned instance ID at T+4h, whether or
not anything else reported in. It does not depend on the instance being reachable.

**Tertiary: a billing check.** `ce:GetCostAndUsage` is granted, so spend for the
`Project=assetflow-capacity` tag is checked before and after; a value above the
ceiling aborts and triggers teardown.

Any one of the three ending the run is sufficient. If the primary and secondary
both fail, the run is already abnormal and teardown is manual.

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

A failed check aborts to teardown; it does not proceed.

## 7. Access rules actually needed

**Inbound from the separate GitHub-hosted generator and evidence client:**

| Port | Purpose | Source |
|------|---------|--------|
| 443/tcp | HTTPS — load generator and evidence export | generator egress as narrowly as GitHub's ranges allow |

That is the only ingress required. **Port 22 is not needed** — no key pair is
attached, so SSH is impossible regardless. Nothing broader is opened.

Widening ingress beyond 443, or to `0.0.0.0/0`, would need separate approval.
Leaving inbound **empty** right now is correct: with no listener and no load, there
is nothing to reach.

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
