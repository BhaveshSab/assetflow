#!/usr/bin/env bash
#
# Open tcp/8443 for exactly one client address, and close exactly that rule.
#
# WHY THE RULE ID MATTERS
# "already absent" is not a safe reading of a failed revoke. A revoke can fail
# because the rule is gone, or because the credentials are wrong, or because the
# region is wrong, or because the group is gone. Reporting all of them the same
# way hides a real failure behind a reassuring message. This records the actual
# SecurityGroupRuleId that was added and revokes that id, then reads back that
# the permission is gone - and distinguishes "revoked" from "could not confirm".
#
# Usage
#   ingress.sh open  --cidr <a.b.c.d/32> --state-dir DIR
#   ingress.sh close --state-dir DIR
#
# Exit status
#   0  the operation succeeded and was confirmed by a read-back
#   1  the operation failed; the API error is printed verbatim
set -uo pipefail

ACTION="${1:?usage: ingress.sh open|close --state-dir DIR}"
shift

: "${SG_ID:?SG_ID must be set}"
: "${RUN_ID:?RUN_ID must be set}"
PORT="${CAPACITY_PORT:-8443}"

CIDR=""
STATE_DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        --cidr) CIDR="${2:?}"; shift 2 ;;
        --state-dir) STATE_DIR="${2:?}"; shift 2 ;;
        *) echo "ingress: unknown argument: $1" >&2; exit 2 ;;
    esac
done

[ -n "$STATE_DIR" ] || { echo "ingress: --state-dir is required" >&2; exit 2; }
mkdir -p "$STATE_DIR"
RULE_FILE="$STATE_DIR/ingress-rule-id"

. "$(dirname "${BASH_SOURCE[0]}")/aws-context.sh"

show_rule() {
    cap_aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$SG_ID" --output json 2>/dev/null \
        | jq -r --argjson p "$PORT" '.SecurityGroupRules[] | select(.FromPort==$p and .IsEgress==false) | "\(.SecurityGroupRuleId) \(.CidrIpv4 // "-")"'
}

case "$ACTION" in
open)
    [ -n "$CIDR" ] || { echo "ingress: --cidr is required for open" >&2; exit 2; }
    case "$CIDR" in
        */32) ;;
        *) echo "ingress: refusing a non-/32 source: $CIDR" >&2; exit 2 ;;
    esac

    # Refuse to add a second rule: two open rules after a failed cleanup is how an
    # allowance silently widens.
    EXISTING=$(show_rule)
    if [ -n "$EXISTING" ]; then
        echo "ingress: a tcp/$PORT rule already exists, refusing to add another:" >&2
        printf '%s\n' "$EXISTING" >&2
        exit 1
    fi

    RESP=$(cap_aws ec2 authorize-security-group-ingress \
        --group-id "$SG_ID" \
        --ip-permissions "IpProtocol=tcp,FromPort=$PORT,ToPort=$PORT,IpRanges=[{CidrIp=$CIDR,Description=capacity-run-$RUN_ID}]" \
        --output json 2>"$STATE_DIR/authorize.err")
    if [ $? -ne 0 ]; then
        echo "ingress: authorize failed:" >&2
        sed 's/Encoded authorization.*//' "$STATE_DIR/authorize.err" >&2
        exit 1
    fi
    # The rule id is the thing to revoke later. Without it we would be guessing.
    RULE_ID=$(printf '%s' "$RESP" | jq -r '.SecurityGroupRules[0].SecurityGroupRuleId // ""')
    if [ -z "$RULE_ID" ]; then
        echo "ingress: authorize returned no SecurityGroupRuleId; reading it back" >&2
        RULE_ID=$(show_rule | awk -v c="$CIDR" '$2==c {print $1}' | head -1)
    fi
    [ -n "$RULE_ID" ] || { echo "ingress: cannot determine the added rule id" >&2; exit 1; }
    printf '%s' "$RULE_ID" > "$RULE_FILE"
    echo "ingress: added $RULE_ID for $CIDR on tcp/$PORT (recorded in $RULE_FILE)"
    show_rule | sed 's/^/  now: /'
    ;;
close)
    if [ -s "$RULE_FILE" ]; then
        RULE_ID=$(cat "$RULE_FILE")
        echo "ingress: revoking rule $RULE_ID by id"
        if ! cap_aws ec2 revoke-security-group-ingress --group-id "$SG_ID" \
                --security-group-rule-ids "$RULE_ID" 2>"$STATE_DIR/revoke.err"; then
            echo "ingress: revoke by id failed:" >&2
            sed 's/Encoded authorization.*//' "$STATE_DIR/revoke.err" >&2
            # Check whether it is genuinely gone before failing the cleanup.
            if [ -z "$(show_rule)" ]; then
                echo "ingress: no tcp/$PORT rule remains, so the revoke failure is stale"
            else
                exit 1
            fi
        fi
    else
        # No recorded id. Revoke by content, and say plainly that we are doing so.
        echo "ingress: no recorded rule id; revoking any tcp/$PORT permission by content" >&2
        REMAINING=$(show_rule)
        if [ -z "$REMAINING" ]; then
            echo "ingress: nothing to revoke"
            exit 0
        fi
        while read -r rid _cidr; do
            [ -n "$rid" ] || continue
            cap_aws ec2 revoke-security-group-ingress --group-id "$SG_ID" \
                --security-group-rule-ids "$rid" 2>"$STATE_DIR/revoke.err" || {
                echo "ingress: revoke of $rid failed:" >&2
                sed 's/Encoded authorization.*//' "$STATE_DIR/revoke.err" >&2
                exit 1; }
        done <<EOF
$REMAINING
EOF
    fi

    LEFT=$(show_rule)
    if [ -n "$LEFT" ]; then
        echo "ingress: a tcp/$PORT rule is still present after revoking:" >&2
        printf '%s\n' "$LEFT" >&2
        exit 1
    fi
    rm -f "$RULE_FILE"
    echo "ingress: confirmed no tcp/$PORT rule remains on $SG_ID"
    ;;
*)
    echo "ingress: unknown action: $ACTION" >&2
    exit 2
    ;;
esac
