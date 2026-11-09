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

## Second finding — budget permissions ARE present; the earlier claim was wrong

**Correction.** An earlier revision of this document said the supported budget
actions were "absent". That was wrong, and it was inferred from failed calls
rather than from the policy. Read-only diagnosis shows the grants are present
and correctly scoped; the denials had a different cause.

### Read-only inspection results

| Check | Result |
|-------|--------|
| `sts get-caller-identity` | `arn:aws:iam::459252806274:user/assetflow-capacity-run`, account `459252806274` — the intended principal, so no caller/profile mismatch |
| `iam get-policy --policy-arn .../assetflow-capacity-run-stage2` | `AccessDenied`, **explicit deny in that same policy** — this identity cannot read its own policy document |

Because IAM inspection is self-denied, the attached policy was inspected
**behaviourally** instead:

| Call | Observed | What it proves |
|------|----------|----------------|
| `budgets describe-budget-actions-for-account` (granted on `*`) | **succeeds**, returns `{"Actions": []}` | the policy version **does** include this statement — rules out a version mismatch and a caller mismatch |
| `budgets describe-budget --budget-name cap-20261109t0800z-a7f3` | `NotFoundException` | authorization **succeeded** and reached the service, so `budgets:ViewBudget` **is** granted on the exact budget ARN |
| `budgets describe-budgets` (all budgets) | `AccessDenied`, `budgets:ViewBudget` on `budget/*` | this call needs ViewBudget on the **wildcard** ARN, which the policy deliberately does not grant |
| `budgets update-budget` with an invalid amount | `ValidationException` | authorization **succeeded** (payload validated after auth), so `budgets:ModifyBudget` **is** granted — and an invalid payload cannot create a budget |

### Actual cause of the denials

The denials come from **resource scope**, not from a missing action and not from
a policy-version or caller mismatch:

* `describe-budget` (one named budget) — authorized.
* `describe-budgets` (list every budget) — needs `budget/*`, which the policy
  intentionally withholds, so the run cannot enumerate the account's budgets.

That is the correct, minimal grant. **No change is required.** Adding
`budget/*` or duplicating statements would only widen access to make a listing
probe succeed, which is exactly what was not to be done.

### Two operational notes

1. **Budgets has no dry-run.** Unlike EC2, there is no `--dry-run` and no
   non-destructive authorization probe. The `update-budget` call above was safe
   *only* because the payload was structurally invalid, so it could not create
   anything even if authorized; the budget was confirmed still absent afterwards
   (`NotFoundException`). Budget creation remains a separate, explicitly
   approved step — it is not part of P1/P2 and was not performed.
2. **The run's own budget checks must use the named budget**, not
   `describe-budgets`. A checklist step that lists budgets will fail by design.

### Supported action names, for the record

`budgets:CreateBudget` and `budgets:DescribeBudgets` do not exist. Creation and
update are authorized against `budgets:ModifyBudget`; reading is
`budgets:ViewBudget`. The removal of the invalid entries was correct, and the
replacement actions are present in the attached policy.

### Distinguishing the two kinds of check

Every P1/P2 EC2 check used **`--dry-run`**, which returns `DryRunOperation` or
`UnauthorizedOperation` and performs no action. The Budgets results above are
**real API calls that were denied** (or, for `update-budget`, authorised but
rejected as unvalidatable) — they are not dry-runs, and no Budgets call
performed a mutation. The report keeps these separate deliberately: an
`AccessDenied` from a real call and a `DryRunOperation` from a dry-run are not
the same evidence.

## State after these checks

| Item | Value |
|------|-------|
| Run-owned instances | 0 |
| Run-owned volumes | 0 |
| Run-owned security groups | 0 |
| Production instance | `running`, untouched |
| Budgets | none created; named-budget access confirmed, account-wide listing intentionally denied |
| Resources created | **none** |

## Status of the checklist

| Item | Status |
|------|--------|
| P1 production denial (instance, volume, SG, EIP) | **PASS** |
| P2 launch authorization | **BLOCKED** — needs the run-owned SG to exist (budget permissions need no change) |
| P3 run-owned positive control | not run (requires the approved instance) |
| Items 3–22 | not started |

## Two further corrections

**CI reference.** The earlier text said the previous commit passed while the
newer one was still running. The accurate sequence, all confirmed from Actions:

| Commit | Workflow run | Result |
|--------|--------------|--------|
| `46519f6` | — | passed |
| `ed6afda` | [`42591789902`](https://github.com/BhaveshSab/assetflow/actions/runs/42591789902) | **failed** — Restore integration: two leak assertions |
| `509f194` | [`42594986863`](https://github.com/BhaveshSab/assetflow/actions/runs/42594986863) | **success** — all six jobs |
| `a414f6c` | none | no run exists: this commit changes only `docs/results/`, and CI is triggered per `pull_request` synchronisation |

The last commit with a workflow run is therefore `509f194`, and the final
`a414f6c` is documentation-only. It is accurate to say "CI passed at `509f194`,
and the only change after it is this report" — it would **not** be accurate to
say "CI passed at `a414f6c`", because no run exists for that SHA. Anyone
auditing should check `509f194`, not the head.

`ed6afda` did not pass. It failed on `interrupted run cleans up`
(`containers=0 volumes=1`) and `no restore resources leaked`
(`volumes=1 networks=1`). The cause was that `retry()` discarded every attempt's
stderr, so a failing `docker volume rm` reported only "cleanup failed", and the
interrupted-run check watched containers and volumes but not networks, giving up
after 20s while cleanup was still working through 1+2+3+4s per-step backoff.
`509f194` keeps the last attempt's error in `RETRY_ERROR`, includes it in the
failure message, polls all three resource types for up to 60s, and leaves the
leak assertion itself unweakened.

**Order of operations.** The intended sequence is:

1. approved run-owned security group creation
2. P2 (launch `--dry-run`)
3. approved instance launch
4. P3 (run-owned termination `--dry-run`)
5. readiness
6. load test
7. evidence export
8. approved cleanup

The run-owned security group requirement is not weakened, and production is not
altered, at any step.
