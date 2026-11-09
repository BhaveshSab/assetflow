#!/usr/bin/env bash
#
# Launch exactly one capacity-run instance from the tested configuration.
#
# This exists because the first real run was launched from a hand-reconstructed
# command line, and that reconstruction was wrong in two ways: the network
# interface was left untagged (which policy statement 08 denies), and no block
# device mapping was supplied, so the AMI's 8 GB root was used instead of the
# approved 30 GB. Both were operator errors, not code errors. Encoding the
# configuration once, in one place, removes the opportunity to make them again.
#
# It refuses to launch if anything disagrees with the approved configuration.
#
#   ./launch-instance.sh --user-data <raw-file> --dry-run   # validate only
#   ./launch-instance.sh --user-data <raw-file>             # really launch
#
set -euo pipefail

PROFILE="${PROFILE:-capacity}"
REGION="ap-southeast-2"
AZ="ap-southeast-2b"
INSTANCE_TYPE="t3.micro"
AMI="ami-01e91e94accc42eec"
SUBNET="subnet-01f25dc99e013aa6a"
SG="sg-012a0191f4e4a9a8c"
ROOT_GB=30
ROOT_TYPE=gp3
PROJECT_TAG="assetflow-capacity"
RUN_ID="cap-20261109t0800z-a7f3"
ACCOUNT="459252806274"
VPC="vpc-0bcfe8d7f2e811bb3"
EXPECTED_COMMIT="${EXPECTED_COMMIT:?EXPECTED_COMMIT must be set to the tested SHA}"
CLIENT_TOKEN="${CLIENT_TOKEN:?CLIENT_TOKEN must be set for launch idempotency}"

USER_DATA=""
DRY_RUN=0
while [ $# -gt 0 ]; do
    case "$1" in
        --user-data) USER_DATA="${2:?}"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# The AWS CLI is a native binary: it cannot open an MSYS-style /c/... path inside a
# file:// URL even though bash can. Convert to a native path so --user-data works
# the same way from Git Bash and from Linux.
case "$USER_DATA" in
    /?/*)
        if command -v cygpath >/dev/null 2>&1; then
            USER_DATA="$(cygpath -w "$USER_DATA")"
        fi ;;
esac

die() { printf '[launch][FATAL] %s\n' "$*" >&2; exit 1; }
say() { printf '[launch] %s\n' "$*"; }

[ -f "$USER_DATA" ] || die "user-data file not found: $USER_DATA"

# ------------------------------------------------------------ A. preconditions
say "== account and region =="
CALLER_ACCOUNT="$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)" \
    || die "cannot read caller identity"
[ "$CALLER_ACCOUNT" = "$ACCOUNT" ] || die "wrong account: $CALLER_ACCOUNT (expected $ACCOUNT)"
say "account $CALLER_ACCOUNT ok"

# The approved configuration must still exist, unchanged, before we launch.
say "== verifying approved target resources =="
AMI_STATE="$(aws ec2 describe-images --profile "$PROFILE" --region "$REGION" \
    --image-ids "$AMI" --query 'Images[0].State' --output text)" || die "cannot describe AMI"
[ "$AMI_STATE" = "available" ] || die "AMI $AMI is not available (state=$AMI_STATE)"

AMI_ROOT_DEV="$(aws ec2 describe-images --profile "$PROFILE" --region "$REGION" \
    --image-ids "$AMI" --query 'Images[0].RootDeviceName' --output text)" || die "cannot read root device"
[ -n "$AMI_ROOT_DEV" ] || die "AMI has no root device name"
say "AMI $AMI available, root device $AMI_ROOT_DEV"

SUBNET_VPC="$(aws ec2 describe-subnets --profile "$PROFILE" --region "$REGION" \
    --subnet-ids "$SUBNET" --query 'Subnets[0].VpcId' --output text)" || die "cannot describe subnet"
[ "$SUBNET_VPC" = "$VPC" ] || die "subnet $SUBNET is in $SUBNET_VPC, expected $VPC"

SUBNET_AZ="$(aws ec2 describe-subnets --profile "$PROFILE" --region "$REGION" \
    --subnet-ids "$SUBNET" --query 'Subnets[0].AvailabilityZone' --output text)"
[ "$SUBNET_AZ" = "$AZ" ] || die "subnet $SUBNET is in $SUBNET_AZ, expected $AZ"

SG_VPC="$(aws ec2 describe-security-groups --profile "$PROFILE" --region "$REGION" \
    --group-ids "$SG" --query 'SecurityGroups[0].VpcId' --output text)" || die "cannot describe SG"
[ "$SG_VPC" = "$VPC" ] || die "SG $SG is in $SG_VPC, expected $VPC"

SG_RUNID="$(aws ec2 describe-security-groups --profile "$PROFILE" --region "$REGION" \
    --group-ids "$SG" --query 'SecurityGroups[0].Tags[?Key==`RunId`]|[0].Value' --output text)"
[ "$SG_RUNID" = "$RUN_ID" ] || die "SG $SG is not tagged for run $RUN_ID (got '$SG_RUNID')"
say "subnet, SG and run tags ok"

# Refuse to duplicate an existing instance: this launcher starts one instance.
say "== refusing to duplicate =="
EXISTING="$(aws ec2 describe-instances --profile "$PROFILE" --region "$REGION" \
    --filters "Name=tag:RunId,Values=$RUN_ID" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'length(Reservations[].Instances[])' --output text)" || die "cannot list instances"
[ "$EXISTING" = "0" ] || die "$EXISTING run-owned instance(s) already exist; refusing to duplicate"
say "no existing instance"

# The payload must fit EC2's 16 KiB raw limit and carry the pinned SHA.
RAW_BYTES="$(wc -c < "$USER_DATA" | tr -d ' ')"
say "user-data: ${RAW_BYTES} bytes"
[ "$RAW_BYTES" -le 16384 ] || die "user-data is ${RAW_BYTES} bytes, over the 16384 limit"
grep -q "$EXPECTED_COMMIT" "$USER_DATA" || die "user-data does not contain the pinned commit"

# ------------------------------------------------------------ B. the launch
# Every resource type that the policy tags is tagged explicitly. Omitting the
# network interface here is what caused the first dry-run to be denied.
# One --tag-specifications flag per resource type. The CLI rejects more than one
# ResourceType in a single value, so these are passed as separate arguments.
TAGSPECS=(
  "ResourceType=instance,Tags=[{Key=Project,Value=$PROJECT_TAG},{Key=RunId,Value=$RUN_ID},{Key=Name,Value=$RUN_ID-instance}]"
  "ResourceType=volume,Tags=[{Key=Project,Value=$PROJECT_TAG},{Key=RunId,Value=$RUN_ID}]"
  "ResourceType=network-interface,Tags=[{Key=Project,Value=$PROJECT_TAG},{Key=RunId,Value=$RUN_ID}]"
)

# The root mapping is explicit and uses the AMI's real root device name. Without
# this the AMI default applies and the volume silently comes out too small.
BDM="DeviceName=$AMI_ROOT_DEV,Ebs={VolumeSize=$ROOT_GB,VolumeType=$ROOT_TYPE,DeleteOnTermination=true}"

ARGS=(--profile "$PROFILE" --region "$REGION"
      --image-id "$AMI"
      --instance-type "$INSTANCE_TYPE"
      --subnet-id "$SUBNET"
      --security-group-ids "$SG"
      --credit-specification CpuCredits=standard
      --instance-initiated-shutdown-behavior terminate
      --client-token "$CLIENT_TOKEN"
      --user-data "file://$USER_DATA"
      --tag-specifications "${TAGSPECS[0]}" "${TAGSPECS[1]}" "${TAGSPECS[2]}"
      --block-device-mappings "$BDM")

say "== launch configuration =="
say "  type      : $INSTANCE_TYPE (CpuCredits=standard)"
say "  ami       : $AMI"
say "  subnet    : $SUBNET ($SUBNET_AZ)"
say "  sg        : $SG"
say "  root      : ${ROOT_GB}GB $ROOT_TYPE on $AMI_ROOT_DEV, DeleteOnTermination=true"
say "  shutdown  : terminate"
say "  commit    : $EXPECTED_COMMIT"
say "  token     : $CLIENT_TOKEN"

if [ "$DRY_RUN" -eq 1 ]; then
    say "== dry run =="
    OUT="$(aws ec2 run-instances "${ARGS[@]}" --dry-run 2>&1 || true)"
    case "$OUT" in
        *DryRunOperation*) say "DRY-RUN OK: request would have succeeded"; exit 0 ;;
        *) die "dry run did not return DryRunOperation: $OUT" ;;
    esac
fi

say "== launching =="
# An uncertain response is reconciled against the client token rather than
# retried, because a retry with the same token is idempotent but a retry with a
# fresh token would create a second instance.
RESP="$(aws ec2 run-instances "${ARGS[@]}" --query 'Instances[0].[InstanceId,State.Name,LaunchTime,Placement.AvailabilityZone]' --output text 2>&1)" || {
    case "$RESP" in
        *Idempotent*|*already*|*InvalidClientToken*)
            die "launch response uncertain; reconcile with token $CLIENT_TOKEN before any retry. Response: $RESP" ;;
        *) die "launch failed: $RESP" ;;
    esac
}
[ -n "$RESP" ] || die "launch returned no output; reconcile with token $CLIENT_TOKEN"

IID="$(printf '%s' "$RESP" | awk '{print $1}')"
say "instance: $IID"
printf '%s\n' "$RESP" > "${USER_DATA%/*}/launch-returned.txt" 2>/dev/null || true
echo "$IID"
