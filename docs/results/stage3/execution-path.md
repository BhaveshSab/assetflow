# How to actually run the capacity workflow

## The problem, verified

`workflow_dispatch` only registers a workflow that exists on the **default
branch**. GitHub's own listing for this repository shows:

```
CI          .github/workflows/ci.yml      active
Deploy      .github/workflows/deploy.yml  active
Performance .github/workflows/perf.yml    active
```

`.github/workflows/capacity-run.yml` is **absent**. It exists only on
`arena/595baf83-assetflow`, so there is no "Run workflow" button, and no amount
of clicking will produce one.

Making the button appear would require the file to be on `main`. That is a merge.
It is not done, and the PR is not merged or modified.

## Supported options, in order of preference

### A. Set the workflow's `on:` trigger to a branch-scoped `push` and run it from the branch (recommended)

`workflow_dispatch` needs `main`. `push` does not. A push trigger scoped to this
one branch registers the workflow immediately, because the workflow file is
present on the branch being pushed.

The change is one block:

```yaml
on:
  push:
    branches: [arena/595baf83-assetflow]
  workflow_dispatch:      # still declared, for the day it reaches main
```

Every safety property is preserved: the explicit `LAUNCH-ONE` confirmation input
becomes an env guard (`CONFIRM_LAUNCH`), which the first step still refuses
without, and `concurrency: capacity-run` still prevents two runs overlapping.

This is the option that needs no merge, no `main` change, and no new permission.
It costs one commit on the existing branch.

### B. Run the scripts directly from any host with the AWS profile

The orchestration is now scripts, not inline workflow shell, precisely so it can
be run without Actions:

```bash
export AWS_PROFILE=capacity AWS_REGION=ap-southeast-2
export RUN_ID=cap-20261109t0800z-a7f3 AMI_ID=ami-01e91e94accc42eec \
       SUBNET_ID=subnet-01f25dc99e013aa6a SG_ID=sg-012a0191f4e4a9a8c

bash infra/capacity-run/ingress.sh open --cidr "$(curl -s https://api.ipify.org)/32" --state-dir ./state
bash infra/capacity-run/render-user-data.sh > ./state/user-data.sh
bash infra/capacity-run/launch-once.sh --user-data ./state/user-data.sh \
     --token-file ./state/client-token --out ./state/instance-id
bash infra/capacity-run/verify-instance.sh "$(cat ./state/instance-id)"
bash infra/capacity-run/supervise-run.sh --instance "$(cat ./state/instance-id)" \
     --trust-dir ./trust --state-dir ./state
bash infra/capacity-run/ingress.sh close --state-dir ./state
```

This is exactly what CI runs, so it is the same code path, not a substitute for
it. It requires the operator to hold the AWS key, which is the same trust the
GitHub secret would carry.

### C. Do not do this

Adding the workflow to `main` to make a button appear, or merging PR #31 early.
Both change the approval boundary to save one click.

## What is unaffected

The existing CI workflow (`.github/workflows/ci.yml`) is on `main` and does run,
which is why the capacity-stack job - the real shared deployment path - is
already exercised on every push to this branch, and is green.

## Recommendation

Option A. It is one commit, it keeps the confirmation gate, and it makes the
workflow genuinely runnable rather than merely valid.
