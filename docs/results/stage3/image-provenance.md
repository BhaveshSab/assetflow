# Stage 3 image provenance

Two revisions are involved and they are **not** the same, so they are recorded
separately rather than presented as one.

| What | Value |
|---|---|
| Branch head at launch | `ab44deda62f0e17181a9d99ff838a9bc917f6389` |
| Image source revision (what CI actually built) | `6716baf31986d9c45eeb4bc5455410bb2968bd06` |
| CI run (green, 8/8) | `42888092072` on the branch head |
| Publish job | *Publish capacity-test images (digest-pinned)* — **success** |

## Why they differ

The workflow triggers on `pull_request`, and GitHub checks out a synthetic merge
commit for that event. `git rev-parse HEAD` inside the job therefore returns the
merge commit, not the branch head. The tags above record which one. The images are built from the
merge of this branch into `main`.

This is stated rather than glossed: the images are built from a commit that
contains exactly this branch's tree merged with the current `main`. They are
**not** byte-for-byte proven to be built from `cbb8102` alone. Anyone asserting
identical provenance would be overclaiming.

## Published images

All three pull anonymously (verified by the CI job after `docker logout` and
removal of `~/.docker/config.json`, and independently by resolving a
pull-scoped token for each package with no credential).

```
ghcr.io/bhaveshsab/assetflow-capacity-api@sha256:29c7c3748239958ae83c6f4238ca9ac16ac5075cad7ddf5afe85333cc025f130
ghcr.io/bhaveshsab/assetflow-capacity-migrate@sha256:c10658535ea7e7d4092297921a405562801bda6286ec0b641d68000042faecb1
ghcr.io/bhaveshsab/assetflow-capacity-web@sha256:17d15ee19b8cc918c97da1b81aa6aa60a98442c04acca9b953a416afca4abc75
```

Tag on each: `6716baf31986d9c45eeb4bc5455410bb2968bd06`. There is **no `latest`**
tag: the publish step only ever pushes the commit tag, so a mutable tag cannot
be substituted.

## What the guest does with them

`infra/capacity-run/image-digests.env` is sourced by the bootstrap. When the
three values are present, `migrate-db.sh` pulls exactly those digests, verifies
the resolved digest matches the requested one, and **compiles nothing**. When
they are absent it builds from the pinned checkout, which is the mode CI
exercises so the shared path stays tested without a registry dependency.

A partial pin, or anything that is not a `repository@sha256:<64 hex>`
reference, is refused with exit 2 rather than falling back to a build.

No credential exists on the guest: the packages are public, so the pull is
anonymous. No instance role, no token file, no new IAM.

## What was kept out of the images

The publish job fails before pushing if any tracked file matches an env, key,
PEM, token, credential or archive pattern, and independently scans each built
filesystem for `.env`, `*.pem` and `*.key` under `/app` and `/usr/src`. Both
checks passed for this run.

## Not claimed

That these images behave identically on a t3.micro. They have never run there.
