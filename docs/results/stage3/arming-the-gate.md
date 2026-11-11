# Arming and firing the one approved launch

## The gate

| Condition | Value |
|---|---|
| Trigger | `push` to `arena/595baf83-assetflow` only |
| Approval | repository **variable** `CAPACITY_APPROVED_SHA` |
| Must equal | the **full 40-character** pushed commit sha |
| Run attempt | must be `1` |
| Otherwise | the launch job **skips** before any AWS call or ingress change |

The variable is a *variable*, not a secret: it is a commit sha, it is meant to be
readable, and it appears in workflow logs.

## Why a variable and not a `LAUNCH-ONE` input

A hardcoded environment value is a constant — it is present on every push, so it
approves every push. Concurrency prevents overlapping runs; it does not stop a
second launch on a later push. Naming the exact commit is single-use: once that
commit has run, no later push can satisfy the condition, because later pushes
have different shas.

## Verified skip behaviour

The push that introduced the gate carried no variable, and the real run shows:

```
Approval gate                     -> success
  Decide whether this run is approved
Launch, observe, clean up         -> skipped
```

`run 42975147935`, event `push`. Afterwards: **0 run instances, 0 ingress
rules.** A skipped job is not a successful AWS execution, and it is not reported
as one.

## Step 1 — get the exact sha to approve

Deciding the sha *before* setting the variable is deliberate: setting the
variable does not trigger anything, so the order is safe.

Open <https://github.com/BhaveshSab/assetflow/commits/arena/595baf83-assetflow>
and copy the **full** sha of the commit you intend to run (click the commit, then
the copy icon next to the 40-character sha). A 7-character short sha is rejected.

## Step 2 — set the variable

1. Open <https://github.com/BhaveshSab/assetflow/settings/variables/actions>
2. **New repository variable**
3. **Name**: `CAPACITY_APPROVED_SHA`
4. **Value**: the full 40-character sha, no spaces, no newline
5. **Add variable**

Guard against a pasted trailing space or newline: the gate compares with `=`,
so `"<sha> "` fails closed rather than matching.

## Step 3 — produce the one push event

**Setting the variable does not trigger a workflow.** GitHub emits an event only
on `push`. Any of these produces exactly one event:

### Option A — re-run the *existing* green commit (recommended)

If the sha you want has already been pushed and is the branch head, there is no
new push to make. Trigger the event by an empty commit, which changes no file:

```bash
cd /c/Users/bhave/assetflow-pr31
git commit --allow-empty -m "Approve capacity run for $(git rev-parse HEAD)"
git rev-parse HEAD          # note this sha
git push origin HEAD:refs/heads/arena/595baf83-assetflow
```

The pushed sha is the *new* empty commit. Approve **that** sha (Step 1–2) before
pushing it, or set the variable to it immediately after: the run from this push
will skip, and you fire the approved one by pushing once more on the same sha
via Option B.

### Option B — push a tag-free no-op on the approved sha

Once `CAPACITY_APPROVED_SHA` equals a commit that is already the branch head, the
next event on that branch fires the gate:

```bash
# Re-run the workflow that GitHub already created for that commit:
#   Actions -> "Capacity run (single launch, gated)" -> the run for that sha
#   -> "Re-run all jobs"
```

A re-run is deliberately rejected (`run_attempt` must be 1), so this does **not**
launch. It is listed here so the behaviour is not a surprise: the supported way
to fire the approved run is a push.

### Option C — the clean sequence (use this one)

1. Make whatever final commit you want to launch, and push it. **It skips.**
2. Note its full sha.
3. Set `CAPACITY_APPROVED_SHA` to that sha.
4. Push an empty commit *on top* — this skips too, because the approved sha is
   no longer the head.

That is a trap, so invert it:

1. Push the commit you want to launch. It skips.
2. Set `CAPACITY_APPROVED_SHA` to the commit **one before** the head.
3. Push an empty commit. Its sha is the new head, so you must approve *it*.

The only ordering that works in one push is: **the sha must be known before it
exists.** That is impossible for the commit being pushed.

**Therefore the supported sequence is two pushes:**

```bash
# 1. Push the commit whose content you want to measure.
git commit --allow-empty -m "Arm capacity gate"
git push origin HEAD:refs/heads/arena/595baf83-assetflow
APPROVED=$(git rev-parse HEAD)
echo "approve this: $APPROVED"

# 2. Set CAPACITY_APPROVED_SHA = $APPROVED in the browser (Step 2).

# 3. Push again so the event exists. To launch the content of $APPROVED, amend
#    nothing: push a second empty commit and approve its sha instead:
git commit --allow-empty -m "Fire capacity run"
git push origin HEAD:refs/heads/arena/595baf83-assetflow

# 4. Approve the second sha, then push once more. Each push skips until the
#    variable names that exact sha.
```

This is awkward, and it is the honest consequence of "no unconditional launch on
push". The practical recipe that needs only **one** firing push is below.

## Practical recipe: one firing push

The commit that fires the gate can be created locally *before* it is pushed, so
its sha is known while the variable can still be set:

```bash
cd /c/Users/bhave/assetflow-pr31
git fetch origin
git checkout arena/595baf83-assetflow

# Build the commit without pushing it. Its sha is final the moment it is created.
git commit --allow-empty -m "Capacity run approval"
SHA=$(git rev-parse HEAD)
echo "Set CAPACITY_APPROVED_SHA to: $SHA"
# >>> now go to the browser and set the variable <<<

# Only after the variable is saved:
git push origin HEAD:refs/heads/arena/595baf83-assetflow
```

The sha does not change when pushed, so the variable set in between matches. One
push, one launch.

## Step 4 — what happens next, and the Stage 3/4 boundary

The `run` job then: writes the AWS profile once, generates the run-scoped secrets
and TLS trust on the runner, discovers the runner's IPv4, checks zero active run
instances and volumes, reads the AMI root device, opens tcp/8443 for that `/32`
only, renders raw shell, launches one instance, reads the configuration back,
runs P3, starts the detached watchdog, polls status from outside, and stops at
readiness.

**It does not terminate on success.** On a successful readiness report the
instance is retained and the ingress rule is left open, because:

- the Stage 4 test must run from **this same runner**, which holds the CA and the
  evidence token that verify the instance's certificate;
- terminating at readiness would leave nothing to test.

Everything is still bounded: the guest terminates itself at its 4-hour deadline
via `InstanceInitiatedShutdownBehavior=terminate`, the watchdog enforces the same
deadline from outside, and the observation step is capped at 230 minutes inside a
240-minute job.

**Termination and ingress removal still happen on failure**, and if the instance
was terminated the rule is removed by its recorded id.

The Stage 4 test requires a separate approval, is not part of this workflow, and
is not authorized by firing this gate.

## Revisions that will execute

| What | Revision |
|---|---|
| Orchestration (workflow + scripts) | the approved pushed sha |
| Guest bootstrap | `render-user-data.sh` at that sha, delivered as raw shell, 16 KiB limit |
| Application images | the three `@sha256:` digests in `infra/capacity-run/image-digests.env` |
| Image build source | `6716baf31986d9c45eeb4bc5455410bb2968bd06` |

## Refresh the digests before launching

CI republishes images on every run, keyed by the synthetic PR merge commit, so
each run yields different digests for the same application source. Verified:

```
6716baf31986 -> sha256:29c7c374...  (currently pinned)
1f26727301ce -> sha256:338744902...  (latest CI build, different)
```

Before an approved launch, copy the three `repo@sha256:` values from the
`capacity-images` job output of the CI run on the commit being launched, and
commit them to `image-digests.env`. Do this as part of the same commit that gets
approved, so the pinned digests and the launched orchestration share one sha.

If the digests are not refreshed, the run still pins to specific digests — it
does not fall back to `latest` — but those digests are older than the launched
commit. That is a provenance gap, not a correctness bug, and it is recorded here
rather than glossed over.
