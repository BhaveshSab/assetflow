# Stage 3 launch tuple (final)

One immutable tuple. Three revisions, recorded separately because they are
different commits and claiming otherwise would be false.

## The tuple

| Component | Revision |
|---|---|
| **Tested orchestration** | `62598ca992991579f4c63fd0948cf273c4a84cd5` |
| **Guest bootstrap** | `render-user-data.sh` at `62598ca` (same commit, delivered as raw shell) |
| **API image** | `ghcr.io/bhaveshsab/assetflow-capacity-api@sha256:29c7c3748239958ae83c6f4238ca9ac16ac5075cad7ddf5afe85333cc025f130` |
| **Migrate image** | `ghcr.io/bhaveshsab/assetflow-capacity-migrate@sha256:c10658535ea7e7d4092297921a405562801bda6286ec0b641d68000042faecb1` |
| **Web image** | `ghcr.io/bhaveshsab/assetflow-capacity-web@sha256:17d15ee19b8cc918c97da1b81aa6aa60a98442c04acca9b953a416afca4abc75` |
| **Image source revision** | `6716baf31986d9c45eeb4bc5455410bb2968bd06` |
| **Image publishing run** | CI run `42886156846` |

The orchestration SHA and the image-source SHA **differ**. That is expected and
acceptable, and it is not a claim of identical provenance.

## Why retaining the existing digests is correct

CI republishes images on every run keyed by the synthetic PR merge commit, so each
run produces different digests for identical application source. Requiring the
launching commit's own future CI digests would be circular. Retaining the
published pins is valid only if three things hold, so each was verified:

**1. Anonymous pulls still work.** Resolved all three with no credential:

```
api      sha256:29c7c374...  MATCH   layers=13
migrate  sha256:c1065853...  MATCH   layers=15
web      sha256:17d15ee1...  MATCH   layers=12
```

CI also asserts this with `docker logout` and `~/.docker/config.json` removed.

**2. Application and build inputs are unchanged.** Every path that feeds the
images is byte-identical between `6716baf` and `62598ca`:

```
backend/            IDENTICAL  fb64394d8f79d5d74bc54faa6572d5a6363df553
src/                IDENTICAL
infra/docker/Dockerfile.api    IDENTICAL
infra/docker/Dockerfile.nginx  IDENTICAL
.dockerignore       IDENTICAL
package.json        IDENTICAL
package-lock.json   IDENTICAL
index.html, postcss.config.js, tailwind.config.ts, components.json,
eslint.config.js, scripts/    IDENTICAL
```

The entire diff between the two commits is confined to `docs/`, `infra/` and
`.github/` - orchestration and documentation. Zero application or build files
differ.

**3. The deployment rehearsal actually exercised those pinned images.** This was
the gap. Every earlier migration and seeding rehearsal ran against locally built
images, which proved the mechanics but never the digests the instance would pull.

CI step **"Rehearse migrations and seeding against the committed pinned images"**
now runs the real deployment path with `FIXTURE_*_DIGEST` set to the committed
values and nothing else:

- asserts the mode marker reports "pulling the pinned images by digest";
- asserts all three digest references appear as pull targets;
- asserts **no** `build.log` exists, so nothing was compiled;
- asserts the pinned migration produced a schema (19 tables);
- seeds through `seed-fixtures.sh`, the same helper the bootstrap runs.

Two real findings came out of building it, both fixed rather than worked around:

- The first attempt checked `pull.log` for the mode marker, but `migrate-db.sh`
  prints it to stdout and `pull.log` holds only `docker pull` output. The
  assertion was wrong, not the pinning.
- The second attempt seeded via the `api` service and failed with `EACCES` on
  `/app/.npm`: the published api image runs as uid `10001` and cannot write a
  root-owned npm cache. The bootstrap avoids this by seeding through the
  `migrate` service via the shared helper. Reusing the helper is also the fix for
  the drift `ci.yml` already warns about - an inline copy is exactly how the
  build-mode and deploy paths diverged before.

## CI status

Run `42984339996` on `62598ca` - **9/9 jobs green**, including the three steps:

```
Verify the committed digests are anonymously pullable        success
Rehearse migrations and seeding against the committed pinned images  success
Record the pinned rehearsal in the job summary               success
```

452 tests OK in a clean clone.

## Account state before approval

```
run instances : none
run volumes   : none
ingress rules : 0
```

## The two required secrets

`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`. Both read once, in one step, passed
through the environment rather than argv.

## The gate

Unchanged and fail-closed. The launch job runs only when the event is a push to
`refs/heads/arena/595baf83-assetflow`, `CAPACITY_APPROVED_SHA` is non-empty,
equals the **full 40-character** pushed sha, and `run_attempt` is `1`. Two
unapproved pushes have already been observed skipping:

```
run 42975147935  fe285c4730f6  Approval gate: success  Launch job: skipped
run 42976575356  3e9efeecd7df  Approval gate: success  Launch job: skipped
```

Each left zero instances and zero ingress rules.
