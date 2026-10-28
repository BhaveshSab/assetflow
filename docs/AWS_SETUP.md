# The AWS setup — click by click

> You have to do this part yourself: it needs your account, your credit card
> and your browser. Everything else in this repository automates it.
>
> **Order matters.** The budget alarm comes *first* — before the instance,
> before the bucket.

## 0. The account and the budget alarm (10 minutes)

1. <https://portal.aws.amazon.com/billing> → **Billing and Cost Management**.
2. **Budgets** → **Create budget**.
   * Name: `assetflow-monthly`
   * Budget amount: `20 USD` (a student project should never cost more)
   * Alert thresholds: **50 %**, **80 %**, **100 %** of the budget
   * Notification: your e-mail address
3. **Billing preferences** → tick **"Receive AWS Free Tier alerts"** and
   **"Receive Billing Alerts"** — otherwise AWS only warns you in the
   dashboard.

> A budget does **not** stop the spending — it only tells you. The second
> layer is the IAM policy below: the deploy user may not create anything
> that costs money.

## 1. The IAM roles (15 minutes)

You need two roles:

### The instance role (for the server)

The server needs **no access key** — it uses the role of the instance.

1. **IAM → Roles → Create role** → *EC2* → name `assetflow-server`.
2. Add a permission policy — **only** the backup bucket:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BackupBucketOnly",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::YOUR-BACKUP-BUCKET",
        "arn:aws:s3:::YOUR-BACKUP-BUCKET/assetflow/*"
      ]
    }
  ]
}
```

3. Attach the role to the instance when you create it (or later:
   *EC2 → Instances → Attach role*).

> The rule of thumb: the role may write **into one bucket and one prefix**.
> It cannot list the buckets, cannot read the other buckets and cannot
> create anything.

### The deploy user (for GitHub Actions)

1. **IAM → Users → Create user** → name `assetflow-deploy`, no console
   access.
2. Attach a policy that may push the image to the registry:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability", "ecr:CompleteLayerUpload",
                 "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart",
                 "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      "Resource": ["arn:aws:ecr:REGION:ACCOUNT:repository/assetflow-api"]
    }
  ]
}
```

3. Create an **access key** for it and put it into the GitHub secrets
   (`GHCR_TOKEN`) — never into the repository.

## 2. The S3 buckets (10 minutes)

Two buckets, both **private**:

| Bucket | What is in it | Lifecycle |
|--------|---------------|-----------|
| `assetflow-backups-YYYYMMDD` | the nightly `pg_dump` | Glacier Instant Retrieval after 30 days, expire after 365, noncurrent versions after 30 |
| `assetflow-archive-YYYYMMDD` | the exported old rows | Glacier after 30 days, expire after 400 days |

For **both** buckets:

1. **S3 → Create bucket** → the name must be globally unique.
2. **Permissions → Block all public access** → all four boxes ticked.
3. **Server-side encryption** → *SSE-S3* (AES-256).
4. **Versioning** → enabled (a deleted backup is still recoverable).
5. **Lifecycle rules**:
   * `assetflow-backups-*` → *Transition to Glacier Instant Retrieval after
     30 days*, *Expire objects after 365 days*, *delete noncurrent versions
     after 30 days*, *abort incomplete multipart uploads after 7 days*
   * `assetflow-archive-*` → *Transition to Glacier Instant Retrieval after
     30 days*, *Expire after 400 days*

   The 14-day figure belongs to the **host**, not the bucket: the local dumps
   are pruned after 14 days, S3 keeps a month of dailies in a cheap class and a
   year of history. A bucket that expires at 14 days cannot answer "what did
   the data look like last month".
6. **Bucket policy** → deny everything that is not TLS:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::YOUR-BUCKET", "arn:aws:s3:::YOUR-BUCKET/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
```

## 3. The EC2 instance (15 minutes)

1. **EC2 → Instances → Launch instance**
   * Name: `assetflow`
   * Image: **Ubuntu Server 24.04 LTS** (x86-64)
   * Instance type: **t3.micro** (1 vCPU, 1 GB) — or `t3.small` if the load
     test says so
   * Key pair: **create a new one** and download the `.pem` file
   * Storage: **30 GB gp3**, delete on termination
   * Network: the default VPC
2. **Security group** — three inbound rules, nothing else:

| Type | Port | Source | Why |
|------|------|--------|-----|
| SSH | 22 | **your own IP** (`curl ifconfig.me`) | administration |
| HTTP | 80 | 0.0.0.0/0 | the redirect + the ACME challenge |
| HTTPS | 443 | 0.0.0.0/0 | the traffic |

> **No port 5432, no port 3001, no port 9090.** The database is only
> reachable from inside the Docker network, and Grafana/Prometheus are bound
> to `127.0.0.1` (you reach them through an SSH tunnel).

3. **Advanced settings → IAM instance profile** → `assetflow-server`.
4. **User data** (optional but handy) — this script installs Docker and
   prepares the host:

```bash
#!/bin/bash
set -euo pipefail
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 certbot unattended-upgrades
curl -fsSL https://get.docker.com | sh
usermod -aG docker ubuntu
```

## 4. The host (20 minutes)

```bash
ssh -i ~/Downloads/assetflow.pem ubuntu@<the-public-ip>

sudo apt update && sudo apt install -y docker.io docker-compose-v2 certbot
sudo infra/scripts/harden-server.sh          # key-only SSH, UFW, updates, journald

sudo mkdir -p /opt/assetflow
sudo chown -R ubuntu:ubuntu /opt/assetflow
git clone https://github.com/BhaveshSab/assetflow.git /opt/assetflow
cd /opt/assetflow

cp infra/.env.example infra/.env
$EDITOR infra/.env                            # secrets, S3 bucket, Telegram, GOOGLE_CLIENT_ID

# Nginx needs a certificate to boot, and HTTP-01 needs Nginx on :80.
# Bootstrap with a self-signed certificate, then issue the real one.
sudo infra/scripts/issue-cert.sh --self-signed
docker compose -f infra/docker-compose.yml up -d --build
sudo infra/scripts/issue-cert.sh --domain <your-domain> --email <you@example.com>
docker compose -f infra/docker-compose.yml exec nginx nginx -s reload
```

## 5. The scheduled backups (5 minutes)

```bash
sudo cp infra/systemd/*.service infra/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now assetflow-backup.timer assetflow-restore-verify.timer
systemctl list-timers | grep assetflow
```

The backup needs the AWS CLI *and* the instance role:

```bash
sudo apt install -y awscli
aws sts get-caller-identity        # must work without any key
```

### If the checkout is not in `/opt`

The systemd units assume `/opt/assetflow` and the `assetflow` service user. When
the code lives in the home directory and nothing runs as root (the layout of
this deployment), use a user crontab instead — `BACKUP_DIR` is required because
`/var/backups` is root-only:

```bash
crontab -e
# BACKUP_DIR=/home/ubuntu/backups
# LOG_DIR=/home/ubuntu/backups/logs
# 30 2 * * * cd /home/ubuntu/assetflow && ./infra/scripts/backup.sh >> /home/ubuntu/backups/backup-cron.log 2>&1
# 0 3 * * 0 cd /home/ubuntu/assetflow && ./infra/scripts/restore-verify.sh >> /home/ubuntu/backups/restore-cron.log 2>&1
```

Verify it by hand once (`BACKUP_DIR=$HOME/backups infra/scripts/backup.sh`)
before trusting the clock to do it.

## 6. The secrets and the variables in GitHub (5 minutes)

Open **Settings → Secrets and variables → Actions**.

**Variables** (they are not secret — the tab next to "Secrets"):

| Variable | Value |
|----------|-------|
| `DEPLOY_HOST` | the public IP of the instance |
| `DEPLOY_USER` | `ubuntu` |
| `DEPLOY_PATH` | the checkout on the server — `/opt/assetflow` for the systemd layout, `/home/ubuntu/assetflow` on this host |

**Secrets**:

| Secret | Value |
|--------|-------|
| `DEPLOY_SSH_KEY` | the content of the `.pem` file |

The workflow pushes the image with the built-in `GITHUB_TOKEN`, so no personal
token is needed there. The **host** does need one to pull a private image — once,
by hand:

```bash
docker login ghcr.io -u <github-user>                                  # a PAT with read:packages
# or make the package public: GitHub → Packages → assetflow-api → Settings → Change visibility
then: IMAGE=ghcr.io/bhaveshsab/assetflow-api:<sha> infra/scripts/deploy.sh
```

Why the host is a *variable* and not a secret: the deployment waits until
`DEPLOY_HOST` exists (`if: vars.DEPLOY_HOST != ''`), and a job condition may
only read the `vars` context — not `secrets`. Until the variable is set, the
deployment is skipped instead of failing.

> The image is pushed with the built-in `GITHUB_TOKEN` (`packages: write`),
> so `GHCR_TOKEN` is only needed for a registry outside GitHub.

## 7. The verification (5 minutes)

```bash
curl -fsS https://<your-host>/api/health/ready
ssh -L 3001:127.0.0.1:3001 -L 9090:127.0.0.1:9090 ubuntu@<the-ip>
# → http://localhost:3001 (Grafana) · http://localhost:9090 (Prometheus)
```

## The cost of the mistakes

| The mistake | What it costs |
|-------------|---------------|
| No budget alarm | a forgotten instance runs for a month (≈ $8) and the e-mail arrives afterwards |
| A security group with `0.0.0.0/0` on 5432 | the database is scanned within minutes — the keys of the world try it |
| A public S3 bucket | the backup (with the data) is world-readable until someone notices |
| An unbounded log | the disk fills, the database stops, the alert fires — at the worst moment |
| A snapshot without a lifecycle rule | the bill grows every month and nobody can explain why |
