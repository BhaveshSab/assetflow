# Slow AWS deployments: diagnosis and safe recovery

This workflow is for the **self-hosted AWS/EC2 stack**, not Vercel. Successful
Vercel checks do not tell us whether the EC2 deployment has completed.

## What the supplied host snapshot establishes

The reported machine has about 908 MiB RAM, a load average around 20, 1 GiB of
swap occupied, and 2.3 GiB free on its root disk. Docker Compose and Buildx
processes have existed for about 30 minutes. Existing API and Nginx containers
report healthy. This supports resource pressure and a long-running build; it
**does not establish which instruction is blocked**, active swap traffic, or
that the intended release has reached the browser. A process's `ps %CPU` is a
lifetime average, and healthy old containers do not prove a deployment succeeded.

The previous workflow built the frontend image on this host and redirected all
remote output into a runner-local file until SSH returned. That combination
could leave Actions silent for a long time.

## What the updated workflow changes

- GitHub Actions builds/pushes **API, migration and web images** tagged with the
  same full release commit SHA. The web image uses the same-origin `/api` URL.
- The host pulls the release images before migrations or API replacement.
  Missing/forbidden image pulls fail rather than silently compiling locally.
- API/migration/web activation explicitly disallows local builds. Local demo
  Compose build definitions remain available outside this deployment workflow.
- Remote output streams through `tee` as it happens; `pipefail` preserves
  connection/command failures. Secrets are not printed with shell tracing.
- The remote payload is fully saved to a private temporary file before running
  it with stdin closed. A child Compose client must never be able to read the
  remaining deployment commands from an SSH `bash -s` command stream. `-T`
  disables a TTY; it does not detach stdin. Temporary script cleanup is attempted
  on normal exit/failure; forced kill can leave a temporary file.
- After web activation, actual running API and Nginx image IDs must match their
  pulled release references. A full-SHA completion marker is required by the
  runner as well. An old but healthy frontend can no longer pass this step.
- The server-side command has a **15 minute deadline**, SSH a longer 18 minute
  deadline, the deploy step 20 minutes, and the entire job 45 minutes. Server
  discovery and final verification also have bounded SSH calls and keepalives.
- A per-user host lock refuses overlapping updated deployments. It does **not**
  detect an old deployment that predates this lock, so inspect that one first.
- Only `main` can deploy, including when manually starting the workflow. The
  clean-checkout, fast-forward-only, exact-image-SHA guards remain intact.

A timeout or cancellation is **not a guarantee of rollback**. Killing a Docker
client or SSH connection can leave daemon-managed work/containers running.
API readiness failure still attempts the existing API-image rollback, but a
later web/monitoring failure does not atomically restore an entire release or
undo database migrations. Inspect the host before retrying.

## Handling the currently stuck run (browser-only)

1. In **GitHub → Actions → Deploy**, note the commit/run and its current step.
   Do not click **Re-run jobs** while server-side work might still be active.
2. Open **AWS Console → EC2 → Instances → select your instance → Connect → EC2
   Instance Connect → Connect**. If already connected, use that terminal.
3. Collect these **read-only** checks:

   ```bash
   vmstat 1 5
   ps -eo pid,ppid,stat,wchan:24,etime,comm --sort=-etime | grep -E 'PID|docker|buildkit|node|npm'
   docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
   docker stats --no-stream
   ```

   `vmstat` swap-in/out (`si`/`so`) and I/O wait (`wa`) help distinguish active
   paging/I/O pressure from swap pages merely remaining allocated. Do not
   install diagnostic packages or run new builds on an overloaded machine.
4. With approval, **Cancel workflow** stops the Actions run and unblocks its
   production concurrency queue. It does not reliably stop the server-side
   build. Confirm the exact remaining build/process before stopping anything.
   Do not kill arbitrary Node/Docker processes, stop Docker, reboot, run
   `compose down`, or prune volumes: those can interrupt the serving app or
   delete data. If the host becomes unresponsive, escalate recovery separately.
5. Only after the old work is confirmed finished/stopped, review the new PR,
   pass CI, merge, and observe the new deployment's live log. An already-running
   workflow does not pick up edits made in a newer commit.

Moving builds off the host removes a large transient load. It does not promise
that an approximately 1 GiB host can comfortably run the API, database, Redis,
and full monitoring stack. Consider more RAM or a reviewed monitoring sizing
change separately; resizing has cost/downtime implications and is not automated
by this patch.

## First rollout prerequisites

The deploy user needs Bash, GNU `timeout`, `flock`, Git and modern Docker Compose
v2 (including `up --no-build` and `up --wait`). The migration one-shot is
started with plain `compose run --rm -T migrate`: `--no-build` is not a `run`
flag, and `run --pull` is missing from older plugins, so the pinned commit tag
in `MIGRATE_IMAGE` — already pulled — is what keeps the run reproducible. The existing database,
secrets and TLS configuration stay on the host.

The host must be able to pull **all three** GHCR packages:
`assetflow-api`, `assetflow-migrate`, and `assetflow-web`. New GHCR packages can
be private even for a public repository. For images intended to be public,
a package owner can use **GitHub profile → Packages → package → Package
settings → Change visibility → Public** after its first publication. Otherwise
configure appropriate read-only registry authentication privately on the host.
Never paste registry tokens, SSH keys, `.env`, or database passwords into chat.
A `denied`/`unauthorized` pull is a registry access problem, not a reason to build
on the production host. Grant access, inspect server state, then retry the
approved release.

## Verify after rollout

Check all of the following, not just green CI:

- The Actions log contains no on-host frontend build and shows the exact three
  SHA-tagged image references being pulled.
- API and Nginx containers are healthy and use the intended release's images
  (`docker ps` above). The ready endpoint returns HTTP 200, not a redirect.
- The website loads the new frontend and the originally failing API requests
  work after login. Vercel must be verified separately on its own deployment.
- Host load/swap activity settles after deployment. Do not run saturation tests
  on this small production server.


## Green deploy, old frontend

If the web release image is present locally but Nginx uses another image ID,
readiness alone is insufficient. Compare selected nonsecret fields with
`docker inspect --format '{{.Name}} {{.Config.Image}} {{.Image}}'` and
`docker image inspect --format '{{.Id}}'` for the agreed release reference.
Do not dump complete inspect output containing environment secrets.

A reproduced cause is stdin consumption: when commands arrive through
`ssh ... bash -s`, a child using stdin can consume the rest of the script,
skipping web activation with exit 0. Compose migration and Prometheus exec
calls now explicitly receive `/dev/null`, and the workflow independently
isolates the entire script payload. Real-Bash transport regressions exercise
stdin-draining children, stale API/web IDs and missing completion. Infra CI
also runs a real Compose exec-without-TTY check in its own temporary project.
This is a reproduced defect, not proof of the cause of a particular host run
without its execution logs.

The completion check proves that the running image IDs match the locally
pulled release references at verification time. It does not replace public
HTTPS, served-asset/cache checks, authenticated business tests or database
integrity verification. Image-ID mismatch fails the workflow; this is not an
automatic whole-stack rollback. Never merge or rerun to fix production without
the agreed backup/recovery and approval gates.
