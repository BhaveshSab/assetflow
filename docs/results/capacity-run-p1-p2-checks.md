# Stage 2 permission checks — P1 and P2

**Run:** `cap-20261109t0800z-a7f3` · **Account** `459252806274` · **Region** `ap-southeast-2`
**IAM user:** `assetflow-capacity-run` · **Policy:** `arn:aws:iam::459252806274:policy/assetflow-capacity-run-stage2`
**PR head:** `46519f60b4ba855a17523082882b3de04ac70930` · **Date:** 2026-11-09

All checks use **`--dry-run` only**. `--dry-run` returns `DryRunOperation` (allowed) or
`UnauthorizedOperation` (denied) and in neither case performs the action. No resource
was created, modified or deleted by any check below.

## Results

| # | Check | Expected | Observed | Status |
|---|-------|----------|----------|--------|
| P1 | `terminate-instances i-0ff4690ec52d0dc01 --dry-run` | `UnauthorizedOperation` | `UnauthorizedOperation`, **explicit deny** in `policy/assetflow-capacity-run-stage2` | **PASS** |
| P1b | `delete-volume vol-0fec8fdb85d35bfa3 --dry-run` | denied | `UnauthorizedOperation` | **PASS** |
| P1c | `delete-security-group sg-088b1c3707a9eb215 --dry-run` | denied | `UnauthorizedOperation` | **PASS** |
| P1d | `release-address eipalloc-013fd2f80167e20a9 --dry-run` | denied | `UnauthorizedOperation` | **PASS** |
| P2 | full `run-instances --dry-run` | `DryRunOperation` | `UnauthorizedOperation` on `network-interface/*` | **NOT YET PASSED — see below** |

Production instance `i-0ff4690ec52d0dc01` was `running` before and after every check.

P1 proves the denial is an **explicit deny**, not merely an absence of permission —
the error names the attached policy. That is the stronger result.

## P2 did not pass, and the reason is correct policy behaviour

The launch probe was denied twice, at two different resource types. Both denials are
the policy enforcing exactly what it was written to enforce; the probe was
under-specified, not the policy wrong.

### Denial 1 — `network-interface/*`

```
not authorized to perform: ec2:RunInstances
  on resource: arn:aws:ec2:ap-southeast-2:459252806274:network-interface/*
```

`08LaunchNetworkInterfaceTagControlled` grants `RunInstances` on `network-interface/*`
only when `aws:RequestTag/Project` and `aws:RequestTag/RunId` are present. A launch
that does not tag the network interface supplies no such request tags, so the
condition fails.

**Fix is in the request, not the policy:** add a `network-interface` tag
specification to `--tag-specifications`. Once added, this denial disappeared.

### Denial 2 — `security-group/sg-041965e6cb9ae9333`

```
not authorized to perform: ec2:RunInstances
  on resource: arn:aws:ec2:ap-southeast-2:459252806274:security-group/sg-041965e6cb9ae9333
```

`sg-041965e6cb9ae9333` is the VPC **default** security group (`default` /
`vpc-0bcfe8d7f2e811bb3`). `10LaunchRunOwnedSecurityGroupOnly` grants `RunInstances`
on a security group only when `ec2:ResourceTag/Project` and `ec2:ResourceTag/RunId`
match the run. The default group carries no such tags, so the launch was correctly
denied — it would have attached the wrong group.

### What this means for the sequence

P2 as the plan wrote it cannot pass yet, because the launch must name a **run-owned
security group that does not exist**. Creating it is a resource-creation step, which
this checkpoint forbids.

The corrected request that P2 will use once the run-owned SG exists:

```
aws ec2 run-instances \
  --image-id ami-01e91e94accc42eec \
  --instance-type t3.micro \
  --subnet-id subnet-01f25dc99e013aa6a \
  --security-group-ids <run-owned-sg-id> \
  --associate-public-ip-address \
  --credit-specification CpuCredits=standard \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications \
      'ResourceType=instance,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3},{Key=Name,Value=assetflow-capacity-host}]' \
      'ResourceType=volume,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]' \
      'ResourceType=network-interface,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]' \
  --dry-run
```

Note `--no-key-name` is not accepted by AWS CLI v1 (`aws-cli/1.46.3`); omitting
`--key-name` entirely has the same effect — no key pair is associated.

An alternative that would let P2 pass *before* any creation is to authorize the
`security-group/*` launch statement against a tag the probe can supply, but that
would weaken the control. It is not recommended: the current behaviour is the
correct one, and the ordering simply needs to place SG creation before P2.

## Second finding — budget permissions are now incomplete

The review removed the invalid `budgets:CreateBudget` and `budgets:DescribeBudgets`
entries. The supported replacements are **not** present, so every budget step fails:

| Operation | Action AWS actually checks | Current result |
|-----------|---------------------------|----------------|
| `budgets describe-budgets` | `budgets:ViewBudget` | `AccessDeniedException` |
| `budgets create-budget` | **`budgets:ModifyBudget`** | `AccessDeniedException` |

Verified empirically: `create-budget` is authorized against **`budgets:ModifyBudget`**,
not `budgets:CreateBudget`. `budgets:DescribeBudgets` does not exist; reading budgets
requires `budgets:ViewBudget`.

The `create-budget` probe was denied before creation, so **no budget exists**. This
could not be confirmed by listing, because listing is itself denied.

Suggested correction, scoped to the run's budget:

```json
{
  "Effect": "Allow",
  "Action": ["budgets:ViewBudget", "budgets:ModifyBudget"],
  "Resource": "arn:aws:budgets::459252806274:budget/cap-20261109t0800z-a7f3"
},
{
  "Effect": "Allow",
  "Action": "budgets:DescribeBudgetActionsForAccount",
  "Resource": "*"
}
```

Because the $1 budget alarm is the spend guardrail, this must be resolved **before**
any billable resource is created — not deferred.

## State after these checks

| Item | Value |
|------|-------|
| Run-owned instances | 0 |
| Run-owned volumes | 0 |
| Run-owned security groups | 0 |
| Production instance | `running`, untouched |
| Budgets | none created; budget APIs denied |
| Resources created | **none** |

## Status of the checklist

| Item | Status |
|------|--------|
| P1 production denial (instance, volume, SG, EIP) | **PASS** |
| P2 launch authorization | **BLOCKED** — needs the run-owned SG to exist, and budget permissions to be corrected |
| P3 run-owned positive control | not run (requires the approved instance) |
| Items 3–22 | not started |
