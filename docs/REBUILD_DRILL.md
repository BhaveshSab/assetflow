# The rebuild drill — the host is gone, put it back

> The strongest line on the resume is not "I ran a backup". It is "I destroyed
> the server and the service was back in N minutes, from S3, with the data".
>
> **Status: not executed yet.** The credentials in `infra/.env`
> (`assetflow-s3-service`) are S3-only — `ec2:DescribeInstances` answers
> `UnauthorizedOperation` — so the destroy/relaunch half needs either the policy
> below or the console. Everything that can be rehearsed without destroying
> anything (backup → S3 → download → restore → verified row counts) **is**
> measured: [results/restore-from-s3-20261028T181200Z.txt](./results/restore-from-s3-20261028T181200Z.txt).

## What the drill proves

| Question | Answered by |
|----------|-------------|
| Is the data really off the host? | the object in S3, not the local dump |
| Is the restore repeatable on a *fresh* machine? | a brand-new instance with no volumes |
| How long is the service down? | stopwatch: terminate → `/api/health/ready` 200 |
| What breaks that nobody planned for? | TLS, DNS, the secrets, the ports — the drill finds them |

## First: write down what you must recreate

Run this **before** destroying anything (or read it off the console):

```bash
aws ec2 describe-instances \
  --filters 'Name=ip-address,Values=3.107.83.86' \
  --query 'Reservations[].Instances[].{id:InstanceId,type:InstanceType,ami:ImageId,az:Placement.AvailabilityZone,sg:SecurityGroups,key:KeyName,subnet:SubnetId}' \
  --output json
```

| What | Where it is recorded now |
|------|--------------------------|
| Instance type | `t3.micro`, ap-southeast-2 |
| AMI | Ubuntu 24.04 (must be re-read from the instance above) |
| Security group | ports 22, 80, 443 only |
| SSH key pair | `assetflow-key` (`~/Downloads/assetflow-key.pem`) |
| Elastic IP | **none** — the public IP changes on relaunch, and so does the sslip.io hostname |
| Secrets | `infra/.env` on the old host — copy it to your laptop first, it is git-ignored *and* not backed up |
| Data | `s3://assetflow-backups-bhavesh-2026/assetflow/backups/` |

> The last row of that table is the trap: the dumps are in S3, but `infra/.env`
> is not. `scp` it off the host before you terminate, or the new host cannot
> decrypt its own database.

## The policy that lets one person do the drill

Attach to the IAM user (scope `Resource` to the account and region):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances", "ec2:DescribeImages", "ec2:DescribeSecurityGroups",
        "ec2:DescribeSubnets", "ec2:DescribeVpcs", "ec2:DescribeKeyPairs"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances", "ec2:TerminateInstances", "ec2:CreateTags",
        "ec2:AllocateAddress", "ec2:AssociateAddress", "ec2:ReleaseAddress"
      ],
      "Resource": "*"
    }
  ]
}
```

The describe actions are harmless; `TerminateInstances` and `ReleaseAddress`
are not. Use a separate user for the drill, and detach the policy afterwards —
the backup script running on the host should never hold it.

## The drill

```bash
# 0. the clock, and the evidence you will quote afterwards
date -u +%Y-%m-%dT%H:%M:%SZ | tee ~/drill-start.txt

# 1. take the settings off the doomed host
scp -i ~/.ssh/assetflow-key.pem ubuntu@3.107.83.86:/home/ubuntu/assetflow/infra/.env ~/assetflow.env

# 2. take the newest backup with you, so you know which object you restored
aws s3 ls s3://assetflow-backups-bhavesh-2026/assetflow/backups/ --human-readable | tail -2

# 3. DESTROY IT
aws ec2 terminate-instances --instance-ids i-xxxxxxxxxxxxxxxxx
aws ec2 wait instance-terminated --instance-ids i-xxxxxxxxxxxxxxxxx

# 4. a fresh machine (same AMI, type, security group, key pair)
aws ec2 run-instances --image-id ami-xxxxxxxx --instance-type t3.micro \
  --key-name assetflow-key --security-group-ids sg-xxxxxxxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=assetflow}]'

# 5. bootstrap it exactly as docs/AWS_SETUP.md says
sudo infra/scripts/harden-server.sh
git clone https://github.com/BhaveshSab/assetflow.git /home/ubuntu/assetflow
scp -i ~/.ssh/assetflow-key.pem ~/assetflow.env ubuntu@<new-ip>:/home/ubuntu/assetflow/infra/.env

# 6. certificate first — sslip.io points at the NEW ip automatically
sudo infra/scripts/issue-cert.sh --domain <new-ip>.sslip.io --email <you@example.com>

# 7. the stack, the schema, then the data
docker compose -f infra/docker-compose.yml up -d --build
docker compose -f infra/docker-compose.yml run --rm migrate
mkdir -p ~/backups
aws s3 cp s3://assetflow-backups-bhavesh-2026/assetflow/backups/ ~/backups/ --recursive
BACKUP_DIR=$HOME/backups infra/scripts/restore-verify.sh          # proves the dump
docker compose exec -T postgres pg_restore -U assetflow -d assetflow \
  --clean --if-exists --no-owner < ~/backups/<newest>.dump         # restores for real

# 8. the customer-visible check, then the clock
curl -fsS https://<new-ip>.sslip.io/api/health/ready
date -u +%Y-%m-%dT%H:%M:%SZ | tee ~/drill-end.txt
```

## What to write down

| Measurement | What counts |
|-------------|-------------|
| Time to destroyed | terminate → `instance-terminated` |
| Time to bootstrapped | → ssh answers |
| Time to data | → `restore-verify.sh` says "the backup can be restored" |
| **RTO** | step 0 → step 8, i.e. when a user could sign in again |
| RPO | the timestamp in the filename of the dump you restored, subtracted from step 0 |
| Surprises | everything that did not survive: IP, certificate, `.env`, Grafana password, cron jobs |

The restore half of this is already measured twice: **8 s** from the local dump
and **14 s** from the S3 copy, with all six tables compared to production. What
is still unknown is the wall-clock time to replace the host itself, and that
number is only honest if it is measured.
