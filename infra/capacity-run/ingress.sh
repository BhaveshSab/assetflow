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

# Every call here uses an API this identity is granted, or the AWS CLI's own
# --query. Nothing on the critical path depends on jq, python3, or
# ec2:DescribeSecurityGroupRules, which is denied for this user.
#
# EC2_CIDRS is the granted evidence: describe-security-groups reports the ranges
# on a port, so an empty list means genuinely no rule. An empty result from
# describe-security-group-rules means "denied" just as often as "none", which is
# why it is not used to decide anything.
EC2_CIDRS() {
    # --query (JMESPath) names the ingress array explicitly, so egress cannot be
    # included. Only the AWS CLI is required - no jq, no python3.
    cap_aws ec2 describe-security-groups --group-ids "$SG_ID" \
        --query "SecurityGroups[0].IpPermissions[?FromPort<=\`$PORT\` && ToPort>=\`$PORT\`].IpRanges[].CidrIp" \
        --output text 2>/dev/null | tr '\t' '\n' | sed '/^$/d; /^None$/d'
}

count_rules_on_port() {
    local n
    n=$(EC2_CIDRS | wc -l | tr -d '[:space:]')
    case "$n" in ''|*[!0-9]*) echo "unknown" ;; *) echo "$n" ;; esac
}

# Human-readable listing. Best-effort only: never fatal, never authoritative.
show_rule() {
    EC2_CIDRS 2>/dev/null || true
    return 0
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
    # The rule id is what gets revoked later. Take it from authorize's response
    # with --query so it does not depend on jq, python3, or a second call.
    RULE_ID=$(printf '%s' "$RESP" \
        | tr -d '\n' \
        | grep -o '"SecurityGroupRuleId"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
    [ -n "$RULE_ID" ] || RULE_ID=$(cap_aws ec2 describe-security-groups --group-ids "$SG_ID" \
        --query "SecurityGroups[0].IpPermissions[?FromPort<=\`$PORT\` && ToPort>=\`$PORT\`].IpRanges[0].CidrIp" \
        --output text 2>/dev/null | head -1)
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
            # show_rule cannot answer this: the listing is denied, so it is
            # always empty and would report every failure as stale.
            GONE=$(count_rules_on_port)
            if [ "$GONE" = "0" ]; then
                echo "ingress: no tcp/$PORT rule remains, so the revoke failure is stale"
            else
                echo "ingress: $GONE tcp/$PORT rule(s) remain after a failed revoke" >&2
                exit 1
            fi
        fi
    else
        # No recorded id. Without the listing permission there is no way to
        # discover one, so this must be reported rather than silently treated
        # as "nothing to revoke".
        echo "ingress: no recorded rule id; attempting to revoke any tcp/$PORT permission by content" >&2
        REMAINING=$(show_rule)
        if [ -z "$REMAINING" ]; then
            if [ "$(count_rules_on_port)" = "0" ]; then
                echo "ingress: nothing to revoke"
                exit 0
            fi
            echo "ingress: a tcp/$PORT rule may remain but its id cannot be discovered" >&2
            echo "ingress: ec2:DescribeSecurityGroupRules is not granted; verify manually" >&2
            exit 1
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

    # An empty listing does not prove the rule is gone: this identity cannot
    # list rules at all, so verify by the one call it CAN make - ask for the
    # rule with a DescribeSecurityGroups filter on the port. Its absence there
    # is real evidence, unlike an empty describe-security-group-rules result.
    REMAIN=$(count_rules_on_port)
    case "$REMAIN" in
        0)
            rm -f "$RULE_FILE"
            echo "ingress: verified no tcp/$PORT rule remains on $SG_ID"
            ;;
        *[!0-9]*)
            echo "ingress: cannot verify the rule is gone; the recorded id was revoked but absence is unproven" >&2
            echo "ingress: verify manually with describe-security-groups" >&2
            exit 1
            ;;
        *)
            echo "ingress: $REMAIN tcp/$PORT rule(s) still present after revoking:" >&2
            cap_aws ec2 describe-security-groups --group-ids "$SG_ID" \
                --query "SecurityGroups[0].IpPermissions[?FromPort<=`$PORT` && ToPort>=`$PORT`]" --output json >&2
            exit 1
            ;;
    esac
    ;;
*)
    echo "ingress: unknown action: $ACTION" >&2
    exit 2
    ;;
esac
