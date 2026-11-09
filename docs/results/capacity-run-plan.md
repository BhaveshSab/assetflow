# Isolated AWS capacity measurement — final execution plan (rev 3)

**Status: AWAITING APPROVAL. No resources created.**
Production, PR #31 and both safety gates remain untouched.

Pinned release: `ac5b482ed9bcc558ca2fec096786fd5055cdf28c` (PR #31 head, 6/6 CI green).
Ceiling: **$5.00**. Resource creation: **not approved**.

---

## 0. The flaw you found in rev 1

Rev 1 planned a ramp to 160 req/s per generator IP while **`infra/nginx/nginx.conf`
limits `/api/` to 100 r/s per IP** (`burst=200 nodelay`, `limit_req_status 429`).
Stage 6 would have been **1.6× over** that limit, throttled, and I would have
reported Nginx's `429` as the server's capacity wall. That is the worst kind of
error this run can produce: a confident number that is simply about the wrong
component.

**I will not raise the Nginx limit.** It is production-equivalent configuration;
raising it to make the benchmark easier would measure a system nobody runs, and
would weaken a safeguard to make a test pass. The ramp is reshaped instead.

---

## 1. Full configuration recorded

The run records the complete instance and container configuration, so the number
is reproducible rather than described.

**Instance:** `t3.micro`, `ap-southeast-2`, on-demand, `standard` credit mode,
2 vCPU / 1024 MB, 30 GB `gp3`, Ubuntu 24.04 LTS.
**The 1-vCPU API quota is retained as-is** (accepted for this benchmark): the API
container is capped at `512M` memory and the host's single usable vCPU is the
quantity under test. Not changed for the run.

**Selected stack** (`infra/docker-compose.yml`), with declared limits:

| Service | Memory limit | Role |
|---|---|---|
| `api` | 512 MB | the benchmark target (1 CPU quota) |
| `postgres` | 1024 MB | database |
| `redis` | 256 MB | rate-limit + cache store |
| `nginx` | 256 MB | **the 100 r/s per-IP edge limiter** |
| **core total** | **2048 MB** | vs **1024 MB host → 2× oversubscribed** |
| `prometheus` | 1024 MB | metrics |
| `grafana` | 512 MB | dashboards |
| `cadvisor` | 256 MB | container metrics |
| `blackbox` | 64 MB | probes |
| **core + monitoring** | **3904 MB** | vs 1024 MB host → **3.8× oversubscribed** |

**Excluded for the measurement:** `worker` and `jobs-redis` (`profiles: [jobs]`),
so background jobs cannot create load outside the measured path. This is a
deliberate deviation from production and is stated in the report.

---

## 2. Memory headroom — measured, not assumed

The numbers above are *ceilings*, not reservations, so oversubscription is not by
itself a problem. What matters is actual RSS, and it must be **measured before the
ramp**, because the failure mode is silent and severe:

- Production survives on 1 GB only because `bootstrap-host.sh` creates **2 GB of
  swap**. Memory pressure is therefore a *known* property of this stack.
- If the host swaps during a stage, latency inflates and a p95 wall may be
  **swap, not CPU**. That would be misreported as a capacity limit.
- If a container is **OOM-killed and restarted** mid-stage, the stage is invalid.

**Verification before the ramp (gate — the run does not start if it fails):**

1. Record swap size and current `SwapFree`.
2. Record per-container RSS via `docker stats --no-stream` and
   `cadvisor` container memory for each of the 8 services.
3. Add the sampled RSS of all containers; require **sum(RSS) ≤ 70 % of 1024 MB**
   with the fixture loaded and a 60 s warm-up. If it exceeds 70 %, **reduce
   monitoring** (drop `grafana`, then `prometheus` sampling rate) and re-measure,
   or abort and report — I will not run a measurement on a host already swapping.

**Captured throughout the ramp:**

| Signal | Source | Resolution |
|---|---|---|
| per-container RSS + `oom_kill` counter | `cadvisor` | 1 s |
| `RestartCount` per container | `docker inspect` | sampled each stage |
| `node_memory_MemAvailable_bytes` | node-exporter | 1 s |
| swap in/out (`pswpin`, `pswpout`) | node-exporter | 1 s |
| kernel OOM lines | `journalctl -k` + `dmesg` | post-run |

**Any stage containing an OOM kill or a container restart is marked INVALID** and
excluded from the capacity conclusion. An invalidated stage is not quietly
dropped; it appears in the table with the reason.

**No unrelated work on the host during measurement:** no image builds, no test
suites, no `npm ci`, no backup runs, no log rotation, no other Docker operations.
Builds happen **before** the ramp; the ramp window is reserved for the ramp. This
is listed as a checklist item because it is the easiest thing to violate
accidentally.
(`vm.swappiness` left at system default and recorded, so swap behaviour is
reproducible rather than tuned to flatter the result.)

---

## 3. Three different 429s — and how each is told apart

This is the heart of the correction. A `429` in this stack can mean three
completely different things, and the plan must distinguish them **from
server-side evidence**, not from guesswork.

| Throttle | Where | Key | Limit | Evidence that identifies it |
|---|---|---|---|---|
| **Nginx edge** | `nginx` `/api/` | client IP | **100 r/s, burst 200, nodelay** | `nginx_access.log`: `"status":429` from the `edge`/nginx container, and **`limit_req` log lines** when `error_log` level includes `warn`; **no** matching API access-log entry |
| **Account/API** | `api` `UserThrottlerGuard` | authenticated user | **300 / 60 s, 60 s block** | API access log shows the request with `429`; Redis holds the throttler's block key; only **one account** affected, others fine |
| **Saturation** | host/API | — | — | **No 429 at all**; instead p95/p99 rise, CPU pins, PG connections/locks climb, queue depth grows |

**How the run produces this evidence:**

1. **Nginx access and error logs are exported for the whole ramp**, with
   `$request_time`, `$upstream_response_time` and status. A 429 that appears in
   Nginx but **not** in the API log is Nginx's.
2. **API-side 429s are tagged by account.** `k6-load.js` already signs in a
   distinct account per VU; the summary reports the offending VU/account, and a
   429 concentrated on one account with others healthy is the **account limiter**.
3. **The Nginx limit is *observed*, not inferred.** Before the ramp, a short
   **limiter-probe** is run from the generator: burst above 100 r/s for ~5 s and
   confirm Nginx returns 429 while the API returns 200 for the same requests. This
   proves the limiter is live and pins exactly what its 429 looks like in the
   evidence. It is a deliberate, bounded, few-second probe, and it is recorded.
4. **Saturation is concluded only when no 429 exists** at the edge or the account
   level, and the resource series support it.

**Consequence for the ramp — the pacing is now set by Nginx, not by the accounts:**
Nginx allows **100 r/s per IP** and the generator has **one IP**. So the measured
ceiling per generator is 100 r/s, not 160.

---

## 4. Revised stages, accounts, pacing, limits, aborts

**Account → VU mapping:** one dedicated account per VU, round-robin
(`((vu-1) % users) + 1`, already implemented). No account is shared, so no account
approaches its own 300/60 s budget.

**Two ceilings, both respected:**

| Constraint | Limit | Per-stage budget |
|---|---|---|
| Nginx per IP (single generator) | 100 r/s | keep ≤ **80 r/s** (80 % headroom) |
| Account (per VU, round-robin) | 300 / 60 s (5 r/s) | keep ≤ **0.8 r/s** per account |

| Stage | VUs | `SLEEP` | req/s/VU | req/s total | % of Nginx 100 r/s | Account r/s | Accounts |
|---|---|---|---|---|---|---|---|
| 1 | 5 | 1 | 0.50 | 2.5 | 3 % | 0.50 | 5 |
| 2 | 10 | 1 | 0.50 | 5.0 | 5 % | 0.50 | 10 |
| 3 | 25 | 1 | 0.50 | 12.5 | 13 % | 0.50 | 25 |
| 4 | 50 | 0.55 | 0.65 | 32.3 | 32 % | 0.65 | 50 |
| 5 | 100 | 0.55 | 0.65 | 64.5 | **65 %** | 0.65 | 100 |
| 6 | 150 | 0.75 | 0.57 | 85.7 | **86 %** | 0.57 | 150 |

**Maximum 85.7 r/s — deliberately under the 100 r/s Nginx limit**, so the edge
limiter is never what ends the ramp. Stage 6 replaces the old 200-VU stage, which
is no longer reachable through one generator IP without tripping Nginx.

**Fixture: 150 accounts, 5,000 assets.** (Was 200; 150 satisfies the widest stage.)

**Honest limitation:** the ramp's ceiling is now the **edge limiter's headroom**,
not the instance's theoretical limit. If the stack is still healthy at 85.7 r/s,
the report says **"not saturated within the single-IP edge budget"** — it does
**not** claim that 85.7 r/s is the capacity. Testing higher would require either
raising the Nginx limit (rejected) or multiple generator IPs (a new decision, not
taken here).

**Stage duration: 2 min** — longer than the 60 s throttle window so a 429 is
systematic rather than incidental, and enough for burst credits to settle.

**Abort thresholds:**

| Condition | Action | Classification |
|---|---|---|
| **Any Nginx 429** | abort ramp | `INVALID — edge limiter`, pacing too high |
| **Any account 429** | abort ramp | `INVALID — account limiter`, pacing too high |
| **Any OOM / container restart** | abort ramp | `INVALID — memory`, stage excluded |
| Error rate ≥ 50 % for 5 s | k6 `abortOnFail` | `ABORTED` — failing, not bending |
| p95 ≥ 1000 ms or errors ≥ 1 % | stop ramp, keep stage | **`SATURATED` — this is the result** |
| 3 consecutive failed `/api/health` | abort | host gone |
| 4 h wall clock | teardown | blast radius |
| spend ≥ $5 | teardown | budget |

A `SATURATED` stage is a **successful** run. An `INVALID` stage is a **failed
measurement** and is never reported as a capacity number.

---

## 5. CPU credits: five-minute resolution, initial balance measured

**Corrections accepted.** Rev 1 claimed 1-minute and argued credits could not run
out. Both were wrong.

- **Resolution: five minutes.** `CPUCreditBalance` is recorded at its actual
  **five-minute** CloudWatch resolution. Detailed (1-minute) monitoring is **not**
  enabled — it costs extra and would still not reach the 1-second resolution I
  originally implied. I state plainly: **a balance change faster than 5 minutes
  cannot be resolved from these metrics.** Inference about a credit cliff is
  therefore coarse, and the report labels it as such.
- **Initial balance is measured, not assumed.** At launch and again before the
  ramp, `CPUCreditBalance` is read and recorded as the starting value.
- **The "credits cannot run out" assumption is removed.** Rev 1's arithmetic
  (288 credits ≈ 144 min of 2-vCPU burst, vs a 12-min ramp) argued a cliff was
  unlikely. That reasoning assumed full-burst consumption throughout and ignored
  the **10 %-of-one-vCPU sustained baseline**, which is the real long-run limit.
  The plan no longer predicts; it records `CPUCreditBalance` at 5 min, and if the
  balance trends toward zero the run reports **`credit-limited`** and says the
  wall is a burst-budget artefact rather than a hardware limit.

Metrics recorded: `CPUCreditBalance`, `CPUCreditUsage`,
`CPUSurplusCreditBalance` (expected 0 in `standard` mode), `CPUUtilization` — all
**5-minute**, alongside 1-second on-host CPU and RSS.

---

## 6. Cost — everything priced as billable

**Free-tier eligibility is not assumed.** Rev 1 asserted a "one concurrent
instance" rule; that was a simplification I invented and it is withdrawn. Web
search was unavailable to verify current AWS free-tier terms, so the plan does
**not** rely on them. Instead:

- **Everything is priced as billable**, with no free-tier credit applied.
- Checklist item 2 asks you to confirm the account's applicable plan/allowance, or
  to accept the billable-basis figure below.
- If free tier *does* apply, the actual charge is lower. Under-estimating is the
  safe direction; assuming a discount is how a budget goes wrong.

| Item | Unit price | 4 h | Basis |
|---|---|---|---|
| EC2 `t3.micro` | $0.0132 / h | **$0.0528** | documented in `docs/COSTS.md` |
| EBS `gp3` 30 GB | $0.08 / GB-month | **$0.0132** | 30 × 0.08 × (4/730) |
| Public IPv4 | **estimate** $0.005/h | **$0.0200** | worst case $0.012/h → $0.0480 |
| CloudWatch (base metrics) | ~$2.10/instance-month | **$0.0115** | estimate, 5-min only |
| Data transfer | — | **$0.0000** | ≪ 100 GB/month |
| Generator (GitHub runner) | — | **$0.0000** | included |
| **Total (billable basis)** | | **≈ $0.098** | worst case **≈ $0.126** |

**Two figures remain estimates** (IPv4, CloudWatch) and are labelled as such
because search was unavailable and I will not fabricate prices. Both are small
enough that the worst plausible case stays **under $0.15**.

**Pricing verification is a hard gate (§12 item 1):** live
`ap-southeast-2` prices are fetched from the AWS Price List API before anything is
created. Abort if the computed 4-hour total exceeds **$5**; **stop and re-ask you
if it exceeds $1**, because you approved a ceiling before these prices were
confirmed.

---

## 7. Generator: separate GitHub-hosted runner

`ubuntu-latest`, $0, no competition with the target.

**Consequences stated:** latency is measured **over the public internet**
(labelled "client-side, over public network", not comparable to production
loopback); the runner is **shared and variable**, so any stage where it is
implicated is labelled "generator-limited"; and it provides **one source IP**,
which is precisely what caps the ramp at 85.7 r/s (§4).

---

## 8. Secure access and secrets

- Run-scoped SSH key pair, installed via cloud-init `authorized_keys`, **deleted at
  teardown and confirmed gone**. Private key never enters the repo, artifacts or logs.
- **No IAM role** on the instance; teardown and leftover checks run from outside.
- Self-signed TLS on the test host; the certificate is exported and **validated by
  the generator** (no `--insecure`).
- Load-test password generated per run, passed via `-e`, never written down.
- **No production secret, no production database, no S3 write.**
- Artifacts **secret-scanned** for the run password, private key and JWT secret
  before upload; the upload aborts if the scan is not clean.

---

## 9. Monitoring and alert verification

Each must be **observed firing and observed resolving**, with the observation kept:

1. **AWS budget alarm** ($5, 50/80/100 %, e-mail) — created **before** any instance;
   verified by temporarily lowering the threshold to something current spend
   exceeds, confirming the mail, then restoring.
2. **Telegram alert** — stop a container → alert; start it → resolution. Both legs.
3. **`cadvisor`** — per-container RSS and `oom_kill`, 1 s (§2).
4. **`node-exporter`** — CPU, memory, swap in/out, 1 s.
5. **Nginx** — access log with `$request_time`/`$upstream_response_time`; error log
   at `warn` so `limit_req` rejections are recorded (§3).
6. **PostgreSQL** — connections, locks, `pg_database_size`, 1 s.
7. **CloudWatch** — credits and CPU at **5 min** (§5).
8. **k6 per stage** — p50/p95/p99, throughput, errors, 429s, by account.

---

## 10. Artifact export before teardown

Export happens **before** termination; if the export fails, teardown is withheld
until it is retried or you explicitly accept the loss.

Checksummed (`sha256sum`) and uploaded off-host as a GitHub Actions artifact:

- per-stage k6 summary and full log; per-second samples CSV
- Nginx access + error logs (the evidence that separates the three 429s)
- API logs with account-attributed 429s
- container RSS / OOM / restart records; kernel OOM extract
- CloudWatch 5-minute credit and CPU exports, **with the initial balance**
- `docker stats`, compose file, image digests, full container configuration
- the live pricing JSON from §6
- limiter-probe transcript (§3.3)
- teardown and leftover-check transcripts

---

## 11. Teardown and leftover checks

Verified termination and deletion — not shutdown:

1. Export artifacts and verify checksums (§10).
2. `terminate-instances`; poll to state **`terminated`** (not `shutting-down`).
3. **Confirm EBS deletion** — `DeleteOnTermination` requested, then poll
   `describe-volumes` until empty; if a volume survives, delete explicitly, and
   fail loudly if that fails.
4. Release the public IPv4; confirm `describe-addresses` empty.
5. Delete the key pair; confirm gone.
6. Final sweep, filtered on run tag — **including the `stopped` check**, which is
   the exact leak rev 1 could have produced and hidden:

```
aws ec2 describe-instances --filters "Name=tag:RunId,Values=<run-id>" \
    "Name=instance-state-name,Values=pending,running,stopping,stopped"
aws ec2 describe-volumes   --filters "Name=tag:RunId,Values=<run-id>"
aws ec2 describe-addresses --filters "Name=tag:RunId,Values=<run-id>"
aws ec2 describe-key-pairs  --filters "Name=key-name,Values=<run-id>-key"
```

Any non-empty result is **LEAK — ACTION REQUIRED**; the run is not complete.

`shutdown -h +240` remains only as a backstop beneath verified termination.
**Production `i-0ff4690ec52d0dc01`, its volume, IP, DNS and bucket are untouched.**

---

## 12. The checklist to approve

- [ ] **1.** Live `ap-southeast-2` pricing fetched; abort if > $5, re-ask if > $1
- [ ] **2.** Account plan/allowance confirmed, **or** billable-basis cost accepted (§6)
- [ ] **3.** Budget alarm created and **observed firing**
- [ ] **4.** Telegram alert observed firing **and resolving**
- [ ] **5.** Full instance + container configuration recorded (§1)
- [ ] **6.** Memory headroom measured: sum(RSS) ≤ 70 % of 1024 MB, swap recorded; abort if not (§2)
- [ ] **7.** Initial `CPUCreditBalance` recorded at launch and pre-ramp (§5)
- [ ] **8.** Run-scoped key pair, cloud-init access, abort timer armed
- [ ] **9.** `t3.micro`, `standard` credit mode, **5-min** monitoring, tags applied
- [ ] **10.** Stack up at `ac5b482` (core + monitoring; `worker`/`jobs-redis` excluded), TLS validated
- [ ] **11.** **Limiter probe**: confirm Nginx allows ≤100 r/s and returns 429 above it (§3.3)
- [ ] **12.** Fixture seeded: **150 accounts, 5,000 assets**, run-scoped
- [ ] **13.** Target binding proven by run-owned sign-in **from the GitHub runner**
- [ ] **14.** Host quiet: no builds, tests, backups or unrelated Docker work (§2)
- [ ] **15.** Ramp 5/10/25/50/100/150 VUs at ≤85.7 r/s, 2 min each, abort rules live (§4)
- [ ] **16.** Zero Nginx 429s, zero account 429s, zero OOMs/restarts throughout
- [ ] **17.** Report: p50/p95/p99, throughput, errors, CPU/RAM/swap/RSS, credits (5-min, initial balance), dataset size, 429 classification
- [ ] **18.** Artifacts exported off-host with checksums verified (§10)
- [ ] **19.** Instance **terminated** and confirmed `terminated`
- [ ] **20.** EBS **deletion confirmed**; IPv4 released; key pair deleted — each confirmed
- [ ] **21.** Final leftover sweep empty, including the `stopped` check (§11)
- [ ] **22.** Cost reconciled against the $5 ceiling

**Ceiling: $5.00. Estimated (billable basis): ~$0.098, worst case ~$0.126.**
**Maximum runtime: 4 hours.**

Approve with: **"approve checklist, ceiling $5"**.

> Rev 3 adds §13 (evidence transport, implemented and tested) and §14
> (policy corrections and the launch request).
---

## 13. Evidence transport (option C) — implemented and tested

Chosen: **a single tarball fetched by the runner before teardown.** No SSH, no
S3, no assumed capability.

### How readiness and collection work without SSH

| Stage | Mechanism |
|---|---|
| Provisioning | cloud-init `user-data` runs `bootstrap-host.sh` then `provision-host.sh --self-signed` (both non-interactive; verified: no `read` prompts) |
| Readiness (runner) | poll `https://<public-ip>/api/health` until `status: ok`, `database: up`, `schema: current`; 15 min bound. The application's own proof, not a port check |
| Metric collection | runner pulls CloudWatch via the AWS API; k6 runs on the runner |
| Host evidence | written on the host to `/var/lib/assetflow-capacity/evidence/`, then packed to `run-evidence.tar.gz` |
| Export (runner) | `infra/scripts/export-evidence.sh` over the run-owned HTTPS endpoint, **before** teardown |

### The endpoint: `infra/scripts/evidence_server.py`

Read-only, authenticated, TLS. Properties, **each covered by a test**:

- bearer token, constant-time compare; **an unset/blank token never authorises** (fails closed at startup)
- path containment: one archive leaf, regex + `resolve()` re-check, no traversal, no symlink escape
- no directory listing; root and unknown names are 404
- `POST/PUT/DELETE/PATCH` refused (405)
- TLS ≥ 1.2; the client verifies against a **pinned certificate with hostname/IP identity check**

### The exporter: `infra/scripts/export-evidence.sh`

- **refuses non-HTTPS URLs** (exit 2)
- **refuses to run without a CA/pin file** (exit 2) — there is no insecure path
- verifies `sha256` against the expected digest; a mismatch never leaves a bad archive in place
- **bounded retries** (`EXPORT_ATTEMPTS`, default 5, linear backoff) with a per-attempt `--max-time`
- **exit 75** = export failed: the caller keeps partial runner evidence, **cleans up anyway**, and marks the run `completed:false`

### Failure behaviour (as agreed)

Teardown is **never withheld indefinitely**. On export failure the run retries a
bounded number of times, preserves whatever evidence the runner already holds,
terminates and deletes all run-owned resources, and reports the run as
**INCOMPLETE** — under the 4-hour ceiling regardless.

### Test evidence

- `infra/tests/test_evidence_server.py` — **16 tests**, real TLS server: auth (valid/wrong/prefix/missing/empty-configured), traversal (4 spellings), write verbs (4), untrusted cert, wrong hostname, pinned cert success, 3 startup fail-closed cases
- `infra/tests/test_export_evidence.py` — **8 tests**: checksum success/mismatch, wrong token, plain-HTTP refusal, untrusted CA, missing CA, bounded retries, no-TLS-bypass static check
- Full suite in a clean clone at the PR head: **127 tests, 126 passed, 1 skipped, 0 failed**

---

## 14. Stage 2 policy corrections (reviewer feedback)

| Finding | Fix |
|---|---|
| SG ARNs cannot use group names | `security-group/*` with `ec2:ResourceTag` conditions; the group ID is unknown at design time by construction |
| Key-pair ARNs cannot use key names | **All key-pair management removed** — the plan has no SSH, so `--no-key-name` and no key permissions at all |
| Creation-time tagging for the new SG | `12TagSecurityGroupAtCreation` with `ec2:CreateAction = CreateSecurityGroup` |
| Network-interface tag alignment | `08LaunchNetworkInterfaceTagControlled` now requires the same `RequestTag` pair as the launch spec |
| CreateSecurityGroup authorized against the VPC, not the SG | `11CreateSecurityGroupInApprovedVpc` targets `vpc/vpc-0bcfe8d7f2e811bb3` — **confirmed empirically**: the dry-run error names the VPC ARN |

### Non-destructive production check

Only `--dry-run` is ever used. It returns `DryRunOperation` (allowed) or
`UnauthorizedOperation` (denied) and **never acts**. The earlier read-only denial
does **not** prove the new policy denies production, so the post-attach
verification is: `terminate-instances ... --dry-run` against
`i-0ff4690ec52d0dc01` must return `UnauthorizedOperation`, and a positive control
(a dry-run against the run-owned instance) must return `DryRunOperation`.

### The launch request the policy must permit

```
aws ec2 run-instances   --image-id ami-01e91e94accc42eec   --instance-type t3.micro   --subnet-id subnet-01f25dc99e013aa6a   --security-group-ids <run-owned-sg-id>   --associate-public-ip-address   --credit-specification CpuCredits=standard   --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3,DeleteOnTermination=true}'   --tag-specifications       'ResourceType=instance,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3},{Key=Name,Value=assetflow-capacity-host}]'       'ResourceType=volume,Tags=[{Key=Project,Value=assetflow-capacity},{Key=RunId,Value=cap-20261109t0800z-a7f3}]'   --no-key-name
```

`--associate-public-ip-address` is what removes the Elastic IP requirement: a
directly assigned public IPv4 costs the same ($0.005/h) and disappears with the
instance, so there is nothing to forget to release.

RunId: **`cap-20261109t0800z-a7f3`**.
Policy name: **`assetflow-capacity-run-stage2`** (20 statements).
