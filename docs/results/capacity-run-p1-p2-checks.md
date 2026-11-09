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

---

## Run-owned security group creation — BLOCKED (missing Allow)

The approved step was to create exactly one run-owned security group, tagged
`Project=assetflow-capacity` / `RunId=cap-20261109t0800z-a7f3`, in
`vpc-0bcfe8d7f2e811bb3`, with **no inbound rules**. It did not succeed.

### Exact error

```
An error occurred (UnauthorizedOperation) when calling the CreateSecurityGroup
operation: User: arn:aws:iam::459252806274:user/assetflow-capacity-run is not
authorized to perform: ec2:CreateSecurityGroup
on resource: arn:aws:ec2:ap-southeast-2:459252806274:vpc/vpc-0bcfe8d7f2e811bb3
because no identity-based policy allows the ec2:CreateSecurityGroup action.
```

Read it precisely: **"no identity-based policy allows"**. This is a *missing
allow*, not an explicit deny. That distinguishes it from every P1 result, which
reported "with an explicit deny in an identity-based policy".

### Narrowing the cause

| Test | Result | Conclusion |
|------|--------|------------|
| `create-security-group` with the run tags | `no identity-based policy allows` | — |
| `create-security-group` with **no tags at all** | `no identity-based policy allows` | the failure is **not** a tag-condition mismatch: removing the condition does not help |
| `describe-security-groups` | succeeds | read access is intact; only creation is absent |

`CreateSecurityGroup` is therefore **absent from the attached policy**. The PR
policy file does contain it as `11CreateSecurityGroupInApprovedVpc`, so the
attached policy and the PR file differ by at least that statement — consistent
with the reviewer's note that statement labels were removed to fit the
managed-policy limit, which may have dropped this statement along with the
metadata.

### What was NOT done

No permission was widened to make the call pass. The tag conditions, the VPC
scoping and the run-tag requirements were not relaxed, and no substitute
resource was created. The call was retried once, without tags, purely as a
**diagnostic** to separate "statement missing" from "condition wrong"; a
successful untagged call would have been reported and discarded, and it did not
succeed.

### State after the attempt

| Item | Value |
|------|-------|
| Run-owned security groups | **0** |
| Run-owned instances | **0** |
| Run-owned volumes | **0** |
| Run budget | absent |
| Production `i-0ff4690ec52d0dc01` | `running`, untouched |
| Residue of the failed call | **none** |

### Smallest necessary correction

Add one statement to the attached policy. This is the PR policy's own statement,
unchanged:

```json
{
  "Effect": "Allow",
  "Action": "ec2:CreateSecurityGroup",
  "Resource": "arn:aws:ec2:ap-southeast-2:459252806274:vpc/vpc-0bcfe8d7f2e811bb3",
  "Condition": {
    "StringEquals": {
      "aws:RequestedRegion": "ap-southeast-2",
      "aws:RequestTag/Project": "assetflow-capacity",
      "aws:RequestTag/RunId": "cap-20261109t0800z-a7f3"
    }
  }
}
```

Also required for the tagged creation to succeed in one call — and also
possibly dropped with the labels:

```json
{
  "Effect": "Allow",
  "Action": "ec2:CreateTags",
  "Resource": "arn:aws:ec2:ap-southeast-2:459252806274:security-group/*",
  "Condition": {
    "StringEquals": {
      "aws:RequestedRegion": "ap-southeast-2",
      "ec2:CreateAction": "CreateSecurityGroup",
      "aws:RequestTag/Project": "assetflow-capacity",
      "aws:RequestTag/RunId": "cap-20261109t0800z-a7f3"
    }
  }
}
```

These are the same two statements the PR already carries. Nothing new is being
requested, and the production denies, the instance-type restriction and the
run-tag conditions are all unchanged.

### Steps still outstanding

1. attach the correction above
2. create the run-owned security group (approved, one group, empty inbound)
3. P2 — `run-instances --dry-run`
4. **stop** for approval before the real launch

---

## Run-owned security group created, and P2 now passes

### Correction: the sweep query was broken, not the state

Earlier sweeps in this report used `--query 'length(@[])'` against
`describe-security-groups`. That expression is invalid for this call — security
groups are returned under a wrapper object, not a bare list — so it errored. The
error was swallowed by `2>/dev/null || 0`, which printed **0**.

So "0 run-owned security groups" in the earlier tables was a measurement failure,
not a real result. The group was never missing. Repeating the same sweep with the
correct array names:

| Resource | Correct query | Result |
|----------|---------------|--------|
| instances | `length(Reservations)` | **0** |
| volumes | `length(Volumes)` | **0** |
| security groups | `length(SecurityGroups)` | **1** |

The instance and volume counts are unaffected — `length(@[])` is valid for those
calls — but the security-group count in every earlier sweep was produced by a
failing command. That is why it is recorded here rather than silently amended.

Cross-checked directly: `sg-012a0191f4e4a9a8c` answers
`describe-security-groups --group-ids`, carries all three tags, and lists in the
approved VPC alongside `default` and `launch-wizard-1`.



The corrected policy was attached and made the default. The previously blocked
step then succeeded on the first attempt.

### Pre-creation duplicate check

| Query | Result |
|-------|--------|
| security groups tagged `RunId=cap-20261109t0800z-a7f3` | none |
| security group named `cap-20261109t0800z-a7f3-sg` | 0 |

Nothing existed, so exactly one group was created.

### The security group

| Property | Value |
|----------|-------|
| Group ID | **`sg-012a0191f4e4a9a8c`** |
| Name | `cap-20261109t0800z-a7f3-sg` |
| VPC | `vpc-0bcfe8d7f2e811bb3` (the approved VPC) |
| **Inbound rules** | **none** — empty, as approved. No port 22, no HTTPS ingress |
| Tags | `Project=assetflow-capacity`, `RunId=cap-20261109t0800z-a7f3`, `Name=assetflow-capacity-sg` |

Tags were supplied **in the creation request** (`--tag-specifications`), not added
afterwards. The default egress rule (`-1` / `0.0.0.0/0`) is AWS's automatic
allow-all-outbound and was not modified. No existing security group was touched.

### P2 — `DryRunOperation`

The complete launch request was run with `--dry-run`, naming this group and
tagging all three resource types:

```
aws ec2 run-instances \
  --image-id ami-01e91e94accc42eec --instance-type t3.micro \
  --subnet-id subnet-01f25dc99e013aa6a \
  --security-group-ids sg-012a0191f4e4a9a8c \
  --associate-public-ip-address --credit-specification CpuCredits=standard \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}' \
  --tag-specifications \
    'ResourceType=instance,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3},{Key=Name,Value=assetflow-capacity-host}]' \
    'ResourceType=volume,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]' \
    'ResourceType=network-interface,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]' \
  --dry-run
```

Exact result:

```
An error occurred (DryRunOperation) when calling the RunInstances operation:
Request would have succeeded, but DryRun flag is set.
```

`DryRunOperation` is the success signal: the request is authorised and would
have succeeded. **No instance was launched.** This is the same classification as
`UnauthorizedOperation` in that neither performs the action — but only
`DryRunOperation` means the request is permitted.

### State after creation and P2

| Item | Value |
|------|-------|
| Run-owned security groups | **1** (`sg-012a0191f4e4a9a8c`) |
| Run-owned instances | **0** |
| Run-owned volumes | **0** |
| Run budget | absent |
| Production `i-0ff4690ec52d0dc01` | `running`, untouched |

### Policy file synced to the attached version

`docs/results/capacity-run-stage2-policy.json` now carries **21 statements**,
matching the attached policy, with two additions/corrections:

* `11bCreateSecurityGroupResourceTagControlled` — `CreateSecurityGroup` on
  `security-group/*`, constrained by region and both run request tags. Its
  absence is what blocked the first attempt.
* The invalid action names are gone: `budgets:CreateBudget` and
  `budgets:DescribeBudgets` do not exist. Creation and update authorize against
  `budgets:ModifyBudget`; reads use `budgets:ViewBudget`.

The file keeps its `Sid` labels, which the attached policy omitted to fit the
managed-policy size limit. Labels are metadata and add no authority, so the two
differ in presentation only. Substance is live-verified: the group was created
and P2 returned `DryRunOperation` under the attached policy.

### CI for this change

| Commit | Content | CI |
|--------|---------|-----|
| `0bf042c` | policy sync + regression tests | **no run was created** — GitHub did not fire `pull_request` for this push |
| `45992c1` | empty commit, same tree | [`42600811364`](https://github.com/BhaveshSab/assetflow/actions/runs/42600811364) — **all six jobs success** |

The workflow has no path filter, so the missing run was a dropped trigger, not a
skipped one. Rather than report the change as tested when it was not, the tree was
re-pushed as an empty commit to force `pull_request` synchronisation.

Confirmed at `45992c1`: Backend, Frontend, Infrastructure, Restore integration,
Load-test fixture isolation and API load regression — **all success**.

Locally before pushing: **151 infra unit tests pass** (1 skipped), including the
19 policy tests.

### Regression coverage

`infra/tests/test_stage2_policy.py` — **19 tests**, six of them new for this
change:

* `CreateSecurityGroup` is authorised on the exact approved VPC, with the region
  condition (the resource type the live error named);
* `CreateSecurityGroup` is authorised on `security-group/*` with region and both
  run tags, and is not a bare wildcard;
* **both** resource authorisations are present — losing either breaks creation,
  and the failure only appears at run time;
* creation-time `CreateTags` still covers `security-group/*`;
* the invalid budget action names are absent and the supported ones present;
* no duplicate statements, so nothing wastes the managed-policy size limit.

---

## Stage 2 policy matched to the corrected attachment

The earlier size mismatch (6,200 vs 6,105) is explained: the VPC-scoped
`CreateSecurityGroup` statement still carried `aws:RequestTag/Project` and
`aws:RequestTag/RunId`. The attachment does not.

**Why the attachment is right.** `aws:RequestTag/*` describes tags on the
resource being created. The VPC statement authorizes against a **VPC ARN**, which
is not the resource being created, so those keys can never match. Requiring them
there made the statement unusable for the authorization it exists to grant.

| Statement | Resource | Condition | Change |
|-----------|----------|-----------|--------|
| `11CreateSecurityGroupInApprovedVpc` | the approved VPC | `aws:RequestedRegion` **only** | conditions removed |
| `11bCreateSecurityGroupResourceTagControlled` | `security-group/*` | region + both request tags | unchanged |

Everything else preserved.

### Size, measured the way the attachment is

| Measure | Value |
|---------|-------|
| Statements | **21** |
| Compact JSON without `Sid` labels | **6105 characters** — matches the attachment exactly |
| Managed-policy limit | 6144 |

The file now reproduces the attachment exactly. Regression coverage pins the size
and statement count so the file cannot drift.

### Equivalence is NOT claimed from P2

`DryRunOperation` exercises `RunInstances`. It says nothing about the VPC-scoped
`CreateSecurityGroup` condition. The earlier live creation succeeded under the
**previously attached** policy, which carried the request-tag conditions — so it
is evidence about that version, not this one. No claim is made that the repository
file and the live policy are equivalent.

### Budget — NOT created, blocked on the notification destination

The budget does not exist (`NotFoundException`), so there is nothing to duplicate.
It was not created.

**The blocker.** A notification-only budget requires a notification destination,
and AWS Budgets delivers only through **SNS**. The Stage 2 policy grants no SNS
action at all:

| Permitted | Not permitted |
|-----------|---------------|
| `budgets:ViewBudget`, `budgets:ModifyBudget` (scoped to the run budget) | any `sns:*` action |
| `budgets:DescribeBudgetActionsForAccount` | `sns:ListTopics`, `sns:CreateTopic`, `sns:Subscribe` |

No SNS topic exists that this identity can see, and it cannot enumerate or create
one. `sns` has no `--dry-run`, so probing would mean creating a real topic — not
done.

The project's Telegram alerting is **not** a usable destination: it is Prometheus
Alertmanager on the production host, a separate mechanism. Budgets cannot deliver
to a webhook or to Telegram.

**Creating the budget without a notification would satisfy the letter of the
request while delivering nothing** — a "notification-only budget" with no
notification is a silent control. It was not created.

The budget is therefore reported as **BLOCKED**, pending one decision:
create a run-scoped SNS topic plus an email subscription, or supply an existing
topic ARN.

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
| P2 launch authorization | **PASS** — `DryRunOperation` |
| P3 run-owned positive control | not run — requires the approved instance to exist |
| Run-owned SG creation | **PASS** — `sg-012a0191f4e4a9a8c`, empty inbound, tagged at creation |
| Items 4–22 | not started |

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
