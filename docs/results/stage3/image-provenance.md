# Stage 3 image provenance

Two revisions are involved and they are **not** the same, so they are recorded
separately rather than presented as one.

| What | Value |
|---|---|
| Branch head (executable artifact, what a human reviews) | `cbb810245ca156b4a1ef3c67f795373713573a95` |
| Image source revision (what CI actually built) | `b0b8289b5053d701b8071ba7ad0b6d827bd88cc1` |
| CI run | `42882129762` |
| Publish job | *Publish capacity-test images (digest-pinned)* — **success** |

## Why they differ

The workflow triggers on `pull_request`, and GitHub checks out a synthetic merge
commit for that event. `git rev-parse HEAD` inside the job therefore returns the
merge commit `b0b8289...`, not the branch head. The images are built from the
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
ghcr.io/bhaveshsab/assetflow-capacity-api@sha256:41e5b24d3b6f1864172bc60f7da24ea5dead7fe40a07e811e791c45c80738e87
ghcr.io/bhaveshsab/assetflow-capacity-migrate@sha256:140d29fa8c433cd62a29a9ee95e26b9dd80af30554acee9e4612857949a71d93
ghcr.io/bhaveshsab/assetflow-capacity-web@sha256:9e19270a9e43bc837aea184bc2fe1b2a8499afe0164df14ea494ce0af1aeb3df
```

Tag on each: `b0b8289b5053d701b8071ba7ad0b6d827bd88cc1`. There is **no `latest`**
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
