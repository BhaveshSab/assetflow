#!/usr/bin/env bash
#
# Read back what EC2 actually created, using the API that reports each field.
#
# WHY NOT ONE describe-instances CALL
# The previous version asserted CreditSpecification and
# InstanceInitiatedShutdownBehavior from describe-instances. Both are absent from
# that response - they are returned as null - so every asserted `== "standard"`
# and `== "terminate"` would have failed on a correctly configured instance.
# Those two fields are only reported by dedicated APIs, so they are asked for
# directly.
#
# Usage
#   verify-instance.sh <instance-id>
#
# Exit status 0 when every property matches, 1 with the mismatches printed.
set -uo pipefail

INSTANCE_ID="${1:?usage: verify-instance.sh <instance-id>}"
: "${RUN_ID:?RUN_ID must be set}"
: "${SG_ID:?SG_ID must be set}"
: "${SUBNET_ID:?SUBNET_ID must be set}"
: "${AMI_ID:?AMI_ID must be set}"
EXPECTED_ACCOUNT="${EXPECTED_ACCOUNT:-459252806274}"
EXPECTED_AZ="${EXPECTED_AZ:-ap-southeast-2b}"
EXPECTED_ROOT="${EXPECTED_ROOT:-/dev/sda1}"

. "$(dirname "${BASH_SOURCE[0]}")/aws-context.sh"

FAILURES=0
ok()   { printf 'ok    %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1: $3"; else bad "$1: got '$3', want '$2'"; fi; }

# ---- identity -------------------------------------------------------------
ACCOUNT=$(cap_aws sts get-caller-identity --query 'Account' --output text 2>/dev/null)
check "account" "$EXPECTED_ACCOUNT" "$ACCOUNT"

# ---- describe-instances: the fields it actually reports -------------------
DESC=$(cap_aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --output json 2>/dev/null)
[ -n "$DESC" ] || { bad "instance $INSTANCE_ID not found"; echo "FAILURES=$FAILURES"; exit 1; }

get() { printf '%s' "$DESC" | jq -r "$1"; }
check "instance type" "t3.micro" "$(get '.Reservations[0].Instances[0].InstanceType')"
check "availability zone" "$EXPECTED_AZ" "$(get '.Reservations[0].Instances[0].Placement.AvailabilityZone')"
check "subnet" "$SUBNET_ID" "$(get '.Reservations[0].Instances[0].SubnetId')"
check "image" "$AMI_ID" "$(get '.Reservations[0].Instances[0].ImageId')"
check "public ip assigned" "yes" "$(get 'if (.Reservations[0].Instances[0].PublicIpAddress // "") == "" then "no" else "yes" end')"
check "no key pair" "" "$(get '.Reservations[0].Instances[0].KeyName // ""')"
check "no instance profile" "null" "$(get '.Reservations[0].Instances[0].IamInstanceProfile // "null" | if . == null then "null" else "set" end')"
check "Project tag" "assetflow-capacity" "$(get '.Reservations[0].Instances[0].Tags[] | select(.Key=="Project") | .Value')"
check "RunId tag" "$RUN_ID" "$(get '.Reservations[0].Instances[0].Tags[] | select(.Key=="RunId") | .Value')"
check "security group" "$SG_ID" "$(get '.Reservations[0].Instances[0].SecurityGroups[0].GroupId')"

# The root mapping and its deletion flag ARE reported here.
ROOT_MAP=$(get ".Reservations[0].Instances[0].BlockDeviceMappings[] | select(.DeviceName==\"$EXPECTED_ROOT\") | \"\(.Ebs.DeleteOnTermination)\"" 2>/dev/null)
check "root device present" "true" "$ROOT_MAP"

# ---- DescribeInstanceAttribute: shutdown behaviour ------------------------
SHUTDOWN=$(cap_aws ec2 describe-instance-attribute --instance-id "$INSTANCE_ID" \
    --attribute instanceInitiatedShutdownBehavior \
    --query 'InstanceInitiatedShutdownBehavior.Value' --output text 2>/dev/null)
check "shutdown behaviour" "terminate" "$SHUTDOWN"

# ---- DescribeInstanceCreditSpecifications: credit mode -------------------
CREDITS=$(cap_aws ec2 describe-instance-credit-specifications --instance-ids "$INSTANCE_ID" \
    --query 'InstanceCreditSpecifications[0].CpuCredits' --output text 2>/dev/null)
check "cpu credits" "standard" "$CREDITS"

# ---- DescribeVolumes: the real size and type ----------------------------
VOL_ID=$(get '.Reservations[0].Instances[0].BlockDeviceMappings[] | select(.DeviceName=="'"$EXPECTED_ROOT"'") | .Ebs.VolumeId')
VOL=$(cap_aws ec2 describe-volumes --volume-ids "$VOL_ID" --output json 2>/dev/null)
vget() { printf '%s' "$VOL" | jq -r "$1"; }
check "root volume size GB" "30" "$(vget '.Volumes[0].Size')"
check "root volume type" "gp3" "$(vget '.Volumes[0].VolumeType')"
check "root volume attached" "$INSTANCE_ID" "$(vget '.Volumes[0].Attachments[0].InstanceId')"
check "root volume delete-on-terminate" "true" "$(vget '.Volumes[0].Attachments[0].DeleteOnTermination')"
check "root volume Project tag" "assetflow-capacity" "$(vget '.Volumes[0].Tags[] | select(.Key=="Project") | .Value')"
check "root volume RunId tag" "$RUN_ID" "$(vget '.Volumes[0].Tags[] | select(.Key=="RunId") | .Value')"

printf 'root_volume=%s\n' "$VOL_ID"
if [ "$FAILURES" -gt 0 ]; then
    echo "FAILURES=$FAILURES"
    exit 1
fi
echo "all configuration properties verified"
