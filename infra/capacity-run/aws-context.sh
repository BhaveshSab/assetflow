#!/usr/bin/env bash
#
# One credential mechanism for the whole capacity run.
#
# WHY THIS EXISTS
# The previous version wrote a [capacity] profile to ~/.aws/credentials but then
# called `aws` 9 times out of 10 without --profile and without AWS_PROFILE. That
# silently depends on whatever the ambient default profile happens to be: it
# works on a machine that has one configured and fails, or worse acts on the
# WRONG ACCOUNT, on one that does not. A capacity run must never be one missing
# environment variable away from touching an unintended account.
#
# So: every AWS call goes through `cap_aws`, which always passes the profile and
# region explicitly. There is no fallback to the default profile by design.
#
# Usage
#   source infra/capacity-run/aws-context.sh
#   cap_aws ec2 describe-instances ...
#
# Environment
#   AWS_PROFILE   required. The profile name to use (default: capacity).
#   AWS_REGION    required. (default: ap-southeast-2)
#
# The caller is expected to have written the matching profile into
# ~/.aws/credentials first. `write_profile` does that from two variables, so the
# values never appear in argv or in a process listing.

CAP_PROFILE="${AWS_PROFILE:-capacity}"
CAP_REGION="${AWS_REGION:-ap-southeast-2}"

# Write the profile the caller will use. Arguments are read from the environment
# so secrets never become command-line arguments.
write_profile() {
    local key_id="${AWS_ACCESS_KEY_ID:-}" secret="${AWS_SECRET_ACCESS_KEY:-}"
    if [ -z "$key_id" ] || [ -z "$secret" ]; then
        echo "aws-context: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set" >&2
        return 2
    fi
    mkdir -p "$HOME/.aws"
    # 600 before any byte is written, so the file is never briefly world-readable.
    local tmp="$HOME/.aws/credentials.tmp.$$"
    ( umask 077; : > "$tmp" )
    chmod 600 "$tmp"
    printf '[%s]\naws_access_key_id = %s\naws_secret_access_key = %s\n' \
        "$CAP_PROFILE" "$key_id" "$secret" > "$tmp"
    mv "$tmp" "$HOME/.aws/credentials"
    chmod 600 "$HOME/.aws/credentials"
    # Prove the profile exists rather than assuming the write worked.
    grep -q "^\[$CAP_PROFILE\]$" "$HOME/.aws/credentials" || {
        echo "aws-context: profile $CAP_PROFILE was not written" >&2
        return 1
    }
}

# Every AWS call. Profile and region are always explicit so an ambient default
# profile can never be used.
cap_aws() {
    aws --profile "$CAP_PROFILE" --region "$CAP_REGION" "$@"
}

# Refuse to proceed if the profile is missing, rather than letting a later call
# fall back to something else.
require_profile() {
    if ! cap_aws sts get-caller-identity --query 'Account' --output text >/dev/null 2>&1; then
        echo "aws-context: profile $CAP_PROFILE cannot authenticate" >&2
        return 1
    fi
    local account
    account="$(cap_aws sts get-caller-identity --query 'Account' --output text)"
    printf '%s' "$account"
}
