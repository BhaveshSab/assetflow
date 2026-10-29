#!/usr/bin/env bash
#
# The rebuild drill: destroy the server, rebuild it from scripts, measure it.
#
#   "Rebuilt from scratch in N minutes" is a claim only if N was measured with
#   the data actually restored and the hostname unchanged.
#
# It is **two phases**, because a script cannot survive the machine it is
# running on:
#
#   phase 1 — teardown   (on the old server, or anywhere with the AWS CLI)
#                        verify the backup, record the launch configuration,
#                        terminate the instance, start the clock.
#
#   phase 2 — rebuild    (on your laptop — NOT on the instance being destroyed)
#                        launch a new instance from the recording, re-associate
#                        the Elastic IP first, provision it, restore the data,
#                        stop the clock, write the report.
#
#   phase 3 — report     assemble docs/results/rebuild-drill-<stamp>.md from
#                        the timeline both phases wrote to S3.
#
# Usage:
#   ./rebuild-drill.sh --phase teardown --allow-instance-id i-0abc... 
#   ./rebuild-drill.sh --phase rebuild  --run 20261029T101500Z
#   ./rebuild-drill.sh --phase report   --run 20261029T101500Z
#   ./rebuild-drill.sh --phase all      (both, from one machine that is not the host)
#
# Options:
#   --allow-instance-id <id>   the instance you mean to destroy (required for teardown)
#   --run <stamp>              which drill (default: the newest one in S3)
#   --ssh-key <path>           the private key (default ~/.ssh/assetflow-key.pem)
#   --domain <host>            the public name (default from infra/.env)
#   --email <address>          the Let's Encrypt contact (default from infra/.env)
#   --deploy-path <dir>        /opt/assetflow by default
#   --backup-max-age <hours>   the S3 gate: the dump must be younger (default 26)
#   --dry-run                  print every AWS command, change nothing
#   --help
#
# What it will NOT do: delete the bucket, the IAM policy, the security group or
# the repository. It replaces an *instance*, nothing else.
#
# Exit codes: 0 = the phase finished, 1 = a step failed (and then: re-associate
# the Elastic IP by hand — an unassociated one is billed and the site is down),
# 2 = usage error.
set -euo pipefail
# shellcheck source=lib/common.sh
source "$(dirname "$0")/lib/common.sh"
init_script "$@"

PHASE=""
ALLOW_INSTANCE_ID=""
RUN_STAMP=""
SSH_KEY="${SSH_KEY:-$HOME/.ssh/assetflow-key.pem}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/assetflow}"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/BhaveshSab/assetflow.git}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
S3_PREFIX="${S3_PREFIX:-assetflow/backups}"
DRILL_PREFIX="${DRILL_PREFIX:-assetflow/drill}"

while [ $# -gt 0 ]; do
    case "$1" in
        --phase) PHASE="$2"; shift ;;
        --allow-instance-id) ALLOW_INSTANCE_ID="$2"; shift ;;
        --run) RUN_STAMP="$2"; shift ;;
        --ssh-key) SSH_KEY="$2"; shift ;;
        --domain) DOMAIN="$2"; shift ;;
        --email) EMAIL="$2"; shift ;;
        --deploy-path) DEPLOY_PATH="$2"; shift ;;
        --backup-max-age) BACKUP_MAX_AGE_HOURS="$2"; shift ;;
        --dry-run|--help|-h) : ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
    shift
done

case "$PHASE" in
    teardown|rebuild|report|all) : ;;
    "") die "--phase is required (teardown, rebuild, report or all)" ;;
    *) die "unknown phase: ${PHASE}" ;;
esac

require_aws() {
    if [ "$DRY_RUN" = true ]; then
        command -v aws >/dev/null 2>&1 \
            || warn "the AWS CLI is not installed here — the plan below is what would run on a configured machine"
        return 0
    fi
    command -v aws >/dev/null 2>&1 || die "the AWS CLI is not installed (apt install awscli)"
    command -v jq >/dev/null 2>&1 || die "jq is not installed (apt install jq)"
    aws sts get-caller-identity >/dev/null 2>&1 \
        || die "the AWS credentials do not work — run 'aws sts get-caller-identity'"
}

bucket() {
    if [ -z "${S3_BUCKET:-}" ]; then
        if [ "$DRY_RUN" = true ]; then printf '<S3_BUCKET>'; return 0; fi
        die "S3_BUCKET is not set (it lives in infra/.env)"
    fi
    printf '%s' "$S3_BUCKET"
}

drill_uri() {
    printf 's3://%s/%s/%s' "$(bucket)" "$DRILL_PREFIX" "$1"
}

# ---------------------------------------------------------------------------
# The state both phases read and write. It lives in S3, because after phase 1
# the local copy is on a terminated disk.
# ---------------------------------------------------------------------------
LOCAL_DIR="${REPO_ROOT}/docs/results"

pull_run() {
    local stamp="$1" dir="${LOCAL_DIR}/rebuild-drill-${1}"
    mkdir -p "$dir"
    aws s3 cp --only-show-errors "$(drill_uri "${stamp}/instance.json")" "${dir}/instance.json" >/dev/null \
        || die "no instance.json for run ${stamp} in $(drill_uri "$stamp")"
    aws s3 cp --only-show-errors "$(drill_uri "${stamp}/timeline.txt")" "${dir}/timeline.txt" >/dev/null 2>&1 || : >"${dir}/timeline.txt"
    printf '%s' "$dir"
}

latest_run() {
    if [ -n "$RUN_STAMP" ]; then
        printf '%s' "$RUN_STAMP"
        return
    fi
    aws s3 cp --only-show-errors "$(drill_uri latest)" - 2>/dev/null | tr -d '[:space:]'
}

timeline_add() {
    # key=value, append-only, uploaded immediately: the clock must survive the
    # machine that started it.
    local dir="$1" key="$2" value="$3"
    printf '%s=%s\n' "$key" "$value" >>"${dir}/timeline.txt"
    aws s3 cp --only-show-errors "${dir}/timeline.txt" "$(drill_uri "${RUN_STAMP}/timeline.txt")" >/dev/null 2>&1 || \
        warn "could not upload the timeline (continuing — the local copy is current)"
}

# ---------------------------------------------------------------------------
# The safety gate. Not optional, not skippable by a flag.
# ---------------------------------------------------------------------------
verify_backup() {
    local stamp="$1"
    say "+ the safety gate: is the data really in S3?"

    local listing
    listing="$(aws s3 ls "s3://$(bucket)/${S3_PREFIX}/" 2>/dev/null || true)"
    [ -n "$listing" ] || die "cannot list s3://$(bucket)/${S3_PREFIX}/ — refusing to destroy anything"

    local newest
    newest="$(printf '%s\n' "$listing" | awk '$4 ~ /\.dump$/ {print $4}' | sort | tail -1)"
    [ -n "$newest" ] || die "no .dump in s3://$(bucket)/${S3_PREFIX}/ — the instance holds the only copy"
    printf '%s\n' "$listing" | awk -v f="$newest" '$4 == f' | grep -q . \
        || die "the newest dump ${newest} is not in the listing"

    local dump_age_hours dump_epoch
    dump_epoch="$(printf '%s\n' "$listing" | awk -v f="$newest" '$4 == f {print $1"T"$2"Z"}' \
        | xargs -I{} date -u -d {} +%s)"
    [ -n "$dump_epoch" ] || die "cannot read the timestamp of ${newest}"
    dump_age_hours="$(awk -v now="$(date +%s)" -v then="$dump_epoch" 'BEGIN{printf "%.2f", (now-then)/3600}')"

    if [ "$(awk -v a="$dump_age_hours" -v m="$BACKUP_MAX_AGE_HOURS" 'BEGIN{print (a > m) ? 1 : 0}')" = "1" ]; then
        die "the newest backup is ${dump_age_hours}h old (limit ${BACKUP_MAX_AGE_HOURS}h) — run infra/scripts/backup.sh first"
    fi
    say "  newest dump: ${newest} (${dump_age_hours}h old)"

    # The checksum is the difference between "a file is there" and "the file is
    # the database". Download both and check them.
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN
    aws s3 cp --only-show-errors "s3://$(bucket)/${S3_PREFIX}/${newest}" "${tmp}/${newest}" >/dev/null \
        || die "cannot download ${newest} — the gate cannot be passed"
    if aws s3 cp --only-show-errors "s3://$(bucket)/${S3_PREFIX}/${newest}.sha256" "${tmp}/${newest}.sha256" >/dev/null 2>&1; then
        ( cd "$tmp" && sha256sum --check --status "${newest}.sha256" ) \
            || die "the checksum of ${newest} does not match — the backup is corrupt"
        say "  checksum: matches"
    else
        die "there is no ${newest}.sha256 next to the dump — an unchecked backup is not a backup"
    fi
    rm -rf "$tmp"

    GATE_DUMP="$newest"
    GATE_DUMP_EPOCH="$dump_epoch"
    say "  the gate passed"
}

# ---------------------------------------------------------------------------
# Phase 1
# ---------------------------------------------------------------------------
phase_teardown() {
    require_aws
    [ -n "$ALLOW_INSTANCE_ID" ] \
        || die "--allow-instance-id <id> is required: this phase terminates a machine"
    RUN_STAMP="${RUN_STAMP:-$(date -u '+%Y%m%dT%H%M%SZ')}"

    say "=== phase 1: teardown (${RUN_STAMP}) ==="
    say "instance: ${ALLOW_INSTANCE_ID}"

    if [ "$DRY_RUN" = true ]; then
        say ""
        say "[dry-run] aws ec2 describe-instances --instance-ids ${ALLOW_INSTANCE_ID}"
        say "[dry-run] aws ec2 describe-instance-attribute --instance-id ${ALLOW_INSTANCE_ID} --attribute userData"
        say "[dry-run] aws ec2 describe-addresses --public-ips <the instance's public ip>"
        say "[dry-run] aws s3 cp s3://$(bucket)/${S3_PREFIX}/<the newest .dump> (+ .sha256) → sha256sum --check"
        say "[dry-run] aws s3 cp instance.json + infra/.env → s3://$(bucket)/${DRILL_PREFIX}/${RUN_STAMP}/"
        say "[dry-run] aws ec2 terminate-instances --instance-ids ${ALLOW_INSTANCE_ID}"
        say "[dry-run] aws ec2 wait instance-terminated --instance-ids ${ALLOW_INSTANCE_ID}"
        say "[dry-run] the clock starts at the terminate call; nothing was changed"
        return 0
    fi

    local json state
    json="$(aws ec2 describe-instances --instance-ids "$ALLOW_INSTANCE_ID" --output json)"
    state="$(jq -r '.Reservations[0].Instances[0].State.Name // "missing"' <<<"$json")"
    [ "$state" = "running" ] || die "the instance is ${state}, not running — nothing to drill"

    local public_ip image_id instance_type subnet_id
    public_ip="$(jq -r '.Reservations[0].Instances[0].PublicIpAddress' <<<"$json")"
    image_id="$(jq -r '.Reservations[0].Instances[0].ImageId' <<<"$json")"
    instance_type="$(jq -r '.Reservations[0].Instances[0].InstanceType' <<<"$json")"
    subnet_id="$(jq -r '.Reservations[0].Instances[0].SubnetId' <<<"$json")"
    say "  ${instance_type} · ${image_id} · ${public_ip}"

    local alloc_id=""
    alloc_id="$(aws ec2 describe-addresses --public-ips "$public_ip" \
        --query 'Addresses[0].AllocationId' --output text 2>/dev/null || true)"
    [ -n "$alloc_id" ] && [ "$alloc_id" != "None" ] \
        || die "the instance has no Elastic IP — a rebuild would change the hostname (allocate one first)"

    verify_backup "$RUN_STAMP"
    local dir="${LOCAL_DIR}/rebuild-drill-${RUN_STAMP}"
    mkdir -p "$dir"

    # The launch configuration, exactly as it is — so the rebuild is faithful
    # rather than "an instance that looks similar".
    local user_data_b64
    user_data_b64="$(aws ec2 describe-instance-attribute --instance-id "$ALLOW_INSTANCE_ID" \
        --attribute userData --query 'UserData.Value' --output text 2>/dev/null || true)"
    [ "$user_data_b64" = "None" ] && user_data_b64=""

    jq -n \
        --arg stamp "$RUN_STAMP" \
        --arg captured_at "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
        --arg instance_id "$ALLOW_INSTANCE_ID" \
        --argjson raw "$json" \
        --arg alloc_id "$alloc_id" \
        --arg user_data "$user_data_b64" \
        --arg dump "$GATE_DUMP" \
        --argjson dump_epoch "$GATE_DUMP_EPOCH" \
        '{
            stamp: $stamp,
            captured_at: $captured_at,
            instance_id: $instance_id,
            image_id: $raw.Reservations[0].Instances[0].ImageId,
            instance_type: $raw.Reservations[0].Instances[0].InstanceType,
            subnet_id: $raw.Reservations[0].Instances[0].SubnetId,
            security_group_ids: [$raw.Reservations[0].Instances[0].SecurityGroups[].GroupId],
            key_name: $raw.Reservations[0].Instances[0].KeyName,
            iam_instance_profile_arn: ($raw.Reservations[0].Instances[0].IamInstanceProfile.Arn // null),
            availability_zone: $raw.Reservations[0].Instances[0].Placement.AvailabilityZone,
            root_device_name: $raw.Reservations[0].Instances[0].RootDeviceName,
            root_volume: ($raw.Reservations[0].Instances[0].BlockDeviceMappings
                | map(select(.DeviceName == $raw.Reservations[0].Instances[0].RootDeviceName))
                | .[0].Ebs // null),
            elastic_ip: { public_ip: $raw.Reservations[0].Instances[0].PublicIpAddress, allocation_id: $alloc_id },
            private_ip: $raw.Reservations[0].Instances[0].PrivateIpAddress,
            user_data_b64: $user_data,
            tags: ($raw.Reservations[0].Instances[0].Tags // []),
            backup: { object: $dump, epoch: $dump_epoch }
        }' >"${dir}/instance.json"
    say "  recorded: ${dir}/instance.json"

    # The configuration the new host needs. It never goes to git — the bucket is
    # private and the object is the operator's own secret file.
    [ -f "${REPO_ROOT}/infra/.env" ] \
        || die "infra/.env is missing — the new host would come back without its secrets"
    cp "${REPO_ROOT}/infra/.env" "${dir}/infra.env"
    chmod 600 "${dir}/infra.env"

    aws s3 cp --only-show-errors "${dir}/instance.json" "$(drill_uri "${RUN_STAMP}/instance.json")" >/dev/null
    aws s3 cp --only-show-errors "${dir}/infra.env" "$(drill_uri "${RUN_STAMP}/infra.env")" >/dev/null
    printf '%s' "$RUN_STAMP" | aws s3 cp --only-show-errors - "$(drill_uri latest)" >/dev/null
    : >"${dir}/timeline.txt"
    timeline_add "$dir" "rpo_dump_object" "$GATE_DUMP"
    timeline_add "$dir" "rpo_dump_epoch" "$GATE_DUMP_EPOCH"
    timeline_add "$dir" "instance_id_old" "$ALLOW_INSTANCE_ID"
    timeline_add "$dir" "elastic_ip" "$public_ip"
    timeline_add "$dir" "allocation_id" "$alloc_id"

    say ""
    say "!!! terminating ${ALLOW_INSTANCE_ID} — the site is going down now"
    local started
    started="$(date +%s)"
    timeline_add "$dir" "t_terminate" "$started"
    aws ec2 terminate-instances --instance-ids "$ALLOW_INSTANCE_ID" >/dev/null
    aws ec2 wait instance-terminated --instance-ids "$ALLOW_INSTANCE_ID"
    timeline_add "$dir" "t_terminated" "$(date +%s)"
    say "  the instance is gone (the Elastic IP ${public_ip} is now unassociated and billed — phase 2 re-attaches it)"

    say ""
    say "next, from your laptop (not from this machine):"
    say "  infra/scripts/rebuild-drill.sh --phase rebuild --run ${RUN_STAMP} --ssh-key <key>"
}

# ---------------------------------------------------------------------------
# Phase 2
# ---------------------------------------------------------------------------
phase_rebuild() {
    require_aws
    RUN_STAMP="$(latest_run)"
    [ -n "$RUN_STAMP" ] || die "no drill found in $(drill_uri latest) — run --phase teardown first"
    say "=== phase 2: rebuild (${RUN_STAMP}) ==="

    # A dry run must work on a machine with no AWS credentials: it reads the
    # local copy of the recording when there is one and prints placeholders
    # when there is not.
    if [ "$DRY_RUN" = true ]; then
        local recorded="${LOCAL_DIR}/rebuild-drill-${RUN_STAMP}/instance.json"
        if [ -f "$recorded" ]; then
            say "  recorded: $(jq -r '.instance_type' "$recorded") from $(jq -r '.image_id' "$recorded"), Elastic IP $(jq -r '.elastic_ip.public_ip' "$recorded")"
            say "  network:  subnet $(jq -r '.subnet_id' "$recorded"), groups $(jq -r '.security_group_ids | join(",")' "$recorded")"
        else
            say "  no local recording for ${RUN_STAMP} — the values come from instance.json in S3"
        fi
        say ""
        say "[dry-run] aws ec2 run-instances --image-id <image> --instance-type <type> --subnet-id <subnet>"
        say "[dry-run]   --security-group-ids <sg> --key-name <key> --iam-instance-profile <arn>"
        say "[dry-run]   --user-data file://<the recorded user data> --block-device-mappings <the recorded root volume>"
        say "[dry-run] aws ec2 associate-address --instance-id <new> --allocation-id <eipalloc> --allow-reassociation"
        say "[dry-run] aws ec2 wait instance-running --instance-ids <new>"
        say "[dry-run] ssh ubuntu@<the Elastic IP>: git clone, provision-host.sh --secrets-file s3://.../infra.env"
        say "[dry-run] ssh: restore-verify.sh, then the live pg_restore, then GET /api/health/ready"
        say "[dry-run] report: docs/results/rebuild-drill-${RUN_STAMP}.md"
        say "[dry-run] nothing was changed"
        return 0
    fi

    local dir
    dir="$(pull_run "$RUN_STAMP")"
    local state="${dir}/instance.json"
    local image_id instance_type subnet_id key_name profile_arn root_device root_type root_size
    local alloc_id elastic_ip user_data_b64
    image_id="$(jq -r '.image_id' "$state")"
    instance_type="$(jq -r '.instance_type' "$state")"
    subnet_id="$(jq -r '.subnet_id' "$state")"
    key_name="$(jq -r '.key_name' "$state")"
    profile_arn="$(jq -r '.iam_instance_profile_arn // ""' "$state")"
    root_device="$(jq -r '.root_device_name // "/dev/sda1"' "$state")"
    root_type="$(jq -r '.root_volume.VolumeType // "gp3"' "$state")"
    root_size="$(jq -r '.root_volume.VolumeSize // 8' "$state")"
    alloc_id="$(jq -r '.elastic_ip.allocation_id' "$state")"
    elastic_ip="$(jq -r '.elastic_ip.public_ip' "$state")"
    user_data_b64="$(jq -r '.user_data_b64 // ""' "$state")"
    [ -n "$DOMAIN" ] || DOMAIN="${HOSTNAME_DOMAIN:-${elastic_ip}.sslip.io}"

    say "launching ${instance_type} from ${image_id}, Elastic IP ${elastic_ip}"

    local -a sg_args=()
    while IFS= read -r sg; do [ -n "$sg" ] && sg_args+=(--security-group-ids "$sg"); done \
        < <(jq -r '.security_group_ids[]' "$state")

    local -a profile_args=()
    if [ -n "$profile_arn" ] && [ "$profile_arn" != "null" ]; then
        profile_args=(--iam-instance-profile "Arn=${profile_arn}")
    fi

    local user_data_file="/dev/null"
    if [ -n "$user_data_b64" ] && [ "$user_data_b64" != "null" ]; then
        user_data_file="$(mktemp)"
        printf '%s' "$user_data_b64" | base64 -d >"$user_data_file"
    fi

    local bdm
    bdm="[{\"DeviceName\":\"${root_device}\",\"Ebs\":{\"VolumeType\":\"${root_type}\",\"VolumeSize\":${root_size},\"DeleteOnTermination\":true}}]"

    local -a run_args=(
        --image-id "$image_id"
        --instance-type "$instance_type"
        --subnet-id "$subnet_id"
        "${sg_args[@]}"
        --key-name "$key_name"
        "${profile_args[@]}"
        --block-device-mappings "$bdm"
        --user-data "file://${user_data_file}"
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=assetflow-rebuild},{Key=drill,Value=${RUN_STAMP}}]"
        --query 'Instances[0].InstanceId'
        --output text
    )

    local new_id
    new_id="$(aws ec2 run-instances "${run_args[@]}")"
    [ -n "$new_id" ] && [ "$new_id" != "None" ] || die "run-instances returned no instance id"
    say "  launched ${new_id}"
    timeline_add "$dir" "instance_id_new" "$new_id"
    timeline_add "$dir" "t_launched" "$(date +%s)"

    # First action after launch: the address. An unassociated Elastic IP is
    # billed, and a portfolio link pointing at a dead address is worse.
    aws ec2 associate-address --instance-id "$new_id" --allocation-id "$alloc_id" --allow-reassociation >/dev/null \
        || warn "the address association failed — do it by hand: aws ec2 associate-address --instance-id ${new_id} --allocation-id ${alloc_id}"
    aws ec2 wait instance-running --instance-ids "$new_id"

    local ip=""
    for _ in $(seq 1 60); do
        ip="$(aws ec2 describe-instances --instance-ids "$new_id" \
            --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
        [ "$ip" = "$elastic_ip" ] && break
        sleep 2
    done
    [ "$ip" = "$elastic_ip" ] || die "the new instance does not carry ${elastic_ip} (it has ${ip}) — associate the address by hand"
    say "  running at ${elastic_ip} (unchanged)"
    timeline_add "$dir" "t_running" "$(date +%s)"

    # SSH: a fresh instance needs ~30 s for cloud-init to start sshd.
    say "+ waiting for ssh"
    local ssh_ok=false
    for _ in $(seq 1 60); do
        if ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 \
            -o BatchMode=yes "ubuntu@${elastic_ip}" true 2>/dev/null; then
            ssh_ok=true; break
        fi
        sleep 5
    done
    [ "$ssh_ok" = true ] || die "ssh did not answer on ${elastic_ip} — check the security group and the key"
    say "  ssh answers"
    timeline_add "$dir" "t_ssh" "$(date +%s)"

    # Provisioning: the whole host, over ssh, from the scripts in the repository.
    say "+ provisioning the host (docker, repo, certificate, stack, schema, timers)"
    local provision_log="${dir}/provision.log"
    # shellcheck disable=SC2087
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "ubuntu@${elastic_ip}" bash -s <<EOF | tee "$provision_log"
set -euo pipefail
if [ ! -d "${DEPLOY_PATH}/.git" ]; then
  sudo mkdir -p "${DEPLOY_PATH}"
  sudo chown ubuntu:ubuntu "${DEPLOY_PATH}"
  git clone --quiet --branch "${BRANCH}" "${REPO_URL}" "${DEPLOY_PATH}"
fi
chmod +x "${DEPLOY_PATH}"/infra/scripts/*.sh
bash "${DEPLOY_PATH}/infra/scripts/provision-host.sh" \
  --deploy-path "${DEPLOY_PATH}" \
  --domain "${DOMAIN}" --email "${EMAIL}" \
  --secrets-file "$(drill_uri "${RUN_STAMP}/infra.env")"
EOF
    grep -q "PROVISION_STEP" "$provision_log" || warn "the provisioning log has no step timings"
    timeline_add "$dir" "t_provisioned" "$(date +%s)"

    # The point of the whole drill: the data comes back from S3.
    local dump
    dump="$(jq -r '.backup.object' "$state")"
    say "+ restoring ${dump} from S3"
    # shellcheck disable=SC2087 # the local values must expand here; the remote ones are escaped
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new "ubuntu@${elastic_ip}" bash -s <<EOF
set -euo pipefail
sudo mkdir -p /var/backups/assetflow
sudo chown ubuntu:ubuntu /var/backups/assetflow
cd /var/backups/assetflow
aws s3 cp --only-show-errors "s3://$(bucket)/${S3_PREFIX}/${dump}" .
aws s3 cp --only-show-errors "s3://$(bucket)/${S3_PREFIX}/${dump}.sha256" .
sha256sum --check --status "${dump}.sha256"
cd ${DEPLOY_PATH}
# 1. restore into a throwaway container: if this fails, the live data is untouched
BACKUP_DIR=/var/backups/assetflow infra/scripts/restore-verify.sh --from "/var/backups/assetflow/${dump}"
# 2. the live restore
docker compose -f infra/docker-compose.yml cp "/var/backups/assetflow/${dump}" postgres:/tmp/restore.dump
docker compose -f infra/docker-compose.yml exec -T -e PGPASSWORD="\$(grep '^POSTGRES_PASSWORD=' infra/.env | cut -d= -f2-)" postgres \\
  pg_restore --clean --if-exists --no-owner --no-privileges \\
  -U "\$(grep '^POSTGRES_USER=' infra/.env | cut -d= -f2- | tr -d '[:space:]')" \\
  -d "\$(grep '^POSTGRES_DB=' infra/.env | cut -d= -f2- | tr -d '[:space:]')" /tmp/restore.dump
docker compose -f infra/docker-compose.yml restart api >/dev/null
EOF
    timeline_add "$dir" "t_restored" "$(date +%s)"

    # Health, with the restored data in place. This is the end of the clock.
    say "+ waiting for the API to answer with the restored data"
    local healthy=false
    for _ in $(seq 1 120); do
        if curl -fsS -m 5 --resolve "${DOMAIN}:443:${elastic_ip}" "https://${DOMAIN}/api/health/ready" >/dev/null 2>&1; then
            healthy=true; break
        fi
        sleep 2
    done
    [ "$healthy" = true ] || die "the API is not ready on https://${DOMAIN} — the drill stopped before the clock"
    timeline_add "$dir" "t_healthy" "$(date +%s)"
    say "  the API is ready"

    phase_report
}

# ---------------------------------------------------------------------------
# Phase 3 — the report
# ---------------------------------------------------------------------------
phase_report() {
    RUN_STAMP="${RUN_STAMP:-$(latest_run)}"
    [ -n "$RUN_STAMP" ] || die "no drill found — run --phase teardown first"
    local dir
    dir="$(pull_run "$RUN_STAMP")"

    local t_terminate t_running t_ssh t_provisioned t_restored t_healthy
    t_terminate="$(grep -m1 '^t_terminate=' "${dir}/timeline.txt" | cut -d= -f2 || true)"
    t_running="$(grep -m1 '^t_running=' "${dir}/timeline.txt" | cut -d= -f2 || true)"
    t_ssh="$(grep -m1 '^t_ssh=' "${dir}/timeline.txt" | cut -d= -f2 || true)"
    t_provisioned="$(grep -m1 '^t_provisioned=' "${dir}/timeline.txt" | cut -d= -f2 || true)"
    t_restored="$(grep -m1 '^t_restored=' "${dir}/timeline.txt" | cut -d= -f2 || true)"
    t_healthy="$(grep -m1 '^t_healthy=' "${dir}/timeline.txt" | cut -d= -f2 || true)"
    local dump_epoch elastic_ip
    dump_epoch="$(grep -m1 '^rpo_dump_epoch=' "${dir}/timeline.txt" | cut -d= -f2 || true)"
    elastic_ip="$(grep -m1 '^elastic_ip=' "${dir}/timeline.txt" | cut -d= -f2 || true)"

    local rto="" rpo=""
    if [ -n "$t_terminate" ] && [ -n "$t_healthy" ]; then
        rto="$(awk -v a="$t_terminate" -v b="$t_healthy" 'BEGIN{printf "%.1f", (b-a)/60}')"
    fi
    if [ -n "$t_terminate" ] && [ -n "$dump_epoch" ]; then
        rpo="$(awk -v a="$dump_epoch" -v b="$t_terminate" 'BEGIN{printf "%.0f", (b-a)/60}')"
    fi

    local report="${LOCAL_DIR}/rebuild-drill-${RUN_STAMP}.md"
    {
        echo "# The host rebuild drill — ${RUN_STAMP}"
        echo ""
        if [ -n "$rto" ]; then
            echo "**The whole host was gone for ${rto} minutes** (terminate → the API ready"
            echo "with the restored data). The newest backup was ${rpo:-?} minutes old at that"
            echo "moment, so that is the **RPO**, and the address never changed."
        else
            echo "> **This drill is incomplete** — the timeline has no \`t_healthy\`, so there"
            echo "> is no RTO. Finish it, or delete the run; do not quote a number from it."
        fi
        echo ""
        echo "## The timeline"
        echo ""
        echo "| Step | At (UTC) | Duration |"
        echo "|---|---|---|"
        row() {
            local label="$1" from="$2" to="$3"
            local at duration
            at="$(date -u -d "@${to}" '+%H:%M:%SZ' 2>/dev/null || echo "?")"
            duration="$(awk -v a="$from" -v b="$to" 'BEGIN{printf "%ds", b-a}')"
            echo "| ${label} | ${at} | ${duration} |"
        }
        [ -n "$t_running" ] && row "the instance was running again" "$t_terminate" "$t_running"
        [ -n "$t_ssh" ] && row "ssh answered" "$t_running" "$t_ssh"
        [ -n "$t_provisioned" ] && row "the host was provisioned" "$t_ssh" "$t_provisioned"
        [ -n "$t_restored" ] && row "the data was restored" "$t_provisioned" "$t_restored"
        [ -n "$t_healthy" ] && row "the API was ready (**the clock stops**)" "$t_restored" "$t_healthy"
        if [ -n "$t_healthy" ] && [ -n "$t_terminate" ]; then
            echo "| **RTO** | | **$(awk -v a="$t_terminate" -v b="$t_healthy" 'BEGIN{printf "%dm %ds", (b-a)/60, (b-a)%60}')** |"
        fi
        echo ""
        echo "## The payout"
        echo ""
        echo "| Metric | Value |"
        echo "|---|---|"
        echo "| RTO (terminate → healthy) | **${rto:-TBD} min** |"
        echo "| RPO (age of the newest backup) | **${rpo:-TBD} min** |"
        echo "| The address | ${elastic_ip:-?} — unchanged |"
        echo "| The backup object | \`$(grep -m1 '^rpo_dump_object=' "${dir}/timeline.txt" | cut -d= -f2 || echo "?")\` |"
        echo ""
        echo "## The provisioning steps"
        echo ""
        if [ -f "${dir}/provision.log" ]; then
            echo "| Step | Duration |"
            echo "|---|---|"
            grep '^PROVISION_STEP' "${dir}/provision.log" \
                | sed -E 's/^PROVISION_STEP name=(.*) seconds=([0-9]+)$/| \1 | \2s |/' || true
        else
            echo "(the provisioning log was not collected)"
        fi
        echo ""
        echo "## The commands"
        echo ""
        echo '```bash'
        echo "# phase 1 — on the old server"
        echo "sudo infra/scripts/rebuild-drill.sh --phase teardown --allow-instance-id <id>"
        echo "# phase 2 — on your laptop"
        echo "infra/scripts/rebuild-drill.sh --phase rebuild --run ${RUN_STAMP} --ssh-key ~/.ssh/assetflow-key.pem"
        echo "# phase 3"
        echo "infra/scripts/rebuild-drill.sh --phase report --run ${RUN_STAMP}"
        echo '```'
        echo ""
        echo "## Raw evidence"
        echo ""
        echo "| File | Contents |"
        echo "|---|---|"
        echo "| \`instance.json\` | the launch configuration recorded before the teardown |"
        echo "| \`timeline.txt\` | every timestamp, append-only, uploaded as it happened |"
        echo "| \`provision.log\` | the provisioning output, including each step's duration |"
    } >"$report"

    say ""
    say "=== the drill report ==="
    say "RTO: ${rto:-TBD} min · RPO: ${rpo:-TBD} min · report: ${report}"
}

# ---------------------------------------------------------------------------
case "$PHASE" in
    teardown) phase_teardown ;;
    rebuild) phase_rebuild ;;
    report) phase_report ;;
    all)
        warn "running both phases from one machine — it must not be the instance being destroyed"
        phase_teardown
        phase_rebuild
        ;;
esac
