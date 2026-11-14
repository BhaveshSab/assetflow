#!/usr/bin/env bash
#
# Fetch the run's evidence archive from the read-only endpoint and verify it.
#
#   ./export-evidence.sh https://<host>:8443 <archive-name> <expected-sha256> <out-file>
#
# Why this is a script and not a one-liner in the workflow: the export is the
# step that decides whether teardown may proceed, so the retry budget, the
# checksum and the failure exit codes need to be reviewable and testable.
#
# Exit codes - a verified export is the ONLY success:
#   0   verified export: the bytes written to <out-file> matched <expected-sha256>
#   75  export failed or unverified: checksum mismatch, missing/blank expected
#       digest, empty download, or the final move failed. The caller keeps the
#       partial runner evidence, cleans up anyway, and marks the run incomplete.
#   2   usage/configuration error (non-HTTPS URL, missing token or CA file)
#
# "Unverified" is not success. There is one deliberate way to fetch without a
# digest - passing '-' - and it exits 76, never 0, so a caller that forgets a
# digest cannot mistake the result for a verified export.
#
# Behaviour on failure (agreed with the operator):
#   * bounded retries with backoff - never an unbounded wait;
#   * the caller keeps whatever partial evidence the runner already has;
#   * teardown is never withheld past the 4-hour ceiling.
#
# TLS: the server certificate is verified against a supplied CA/pin file and the
# hostname is checked. There is no --insecure path, and none is accepted.
#
# Environment:
#   EVIDENCE_TOKEN   bearer token (required)
#   EVIDENCE_CA      path to the certificate to trust (required)
#   EXPORT_ATTEMPTS  total attempts (default 5)
#   EXPORT_TIMEOUT   per-attempt timeout in seconds (default 120)
#   EXPORT_RESOLVE   optional "host:port:address" mapping passed to curl
#                    --resolve. The run certificate carries a fixed DNS SAN, so
#                    the client connects to the real address while still verifying
#                    the certified name. Empty means plain DNS.

set -uo pipefail

EXIT_UNVERIFIED=76
EXIT_FAILED=75
EXIT_USAGE=2

usage() {
    echo "usage: export-evidence.sh <base-url> <archive-name> <expected-sha256> <out-file>" >&2
    exit "$EXIT_USAGE"
}

[ $# -eq 4 ] || usage
BASE_URL="$1"
ARCHIVE="$2"
EXPECTED_SHA="$3"
OUT="$4"

ATTEMPTS="${EXPORT_ATTEMPTS:-5}"
TIMEOUT="${EXPORT_TIMEOUT:-120}"

[ -n "${EVIDENCE_TOKEN:-}" ] || { echo "EVIDENCE_TOKEN is not set" >&2; exit "$EXIT_USAGE"; }
[ -n "${EVIDENCE_CA:-}" ] || { echo "EVIDENCE_CA is not set (refusing to fetch unverified)" >&2; exit "$EXIT_USAGE"; }
[ -f "$EVIDENCE_CA" ] || { echo "EVIDENCE_CA does not exist: $EVIDENCE_CA" >&2; exit "$EXIT_USAGE"; }
case "$BASE_URL" in
    https://*) ;;
    *) echo "refusing a non-HTTPS evidence URL: $BASE_URL" >&2; exit "$EXIT_USAGE" ;;
esac

# A real digest is 64 hex characters. Anything else - including the literal '-'
# and an empty string - is not a verification, so it goes down the unverified
# path and can never be reported as a successful verified export.
UNVERIFIED_MODE=0
if [ "$EXPECTED_SHA" = "-" ]; then
    UNVERIFIED_MODE=1
elif ! printf '%s' "$EXPECTED_SHA" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    echo "expected sha256 is not 64 hex characters: '${EXPECTED_SHA}'" >&2
    echo "use '-' for an explicitly unverified fetch (which cannot report success)" >&2
    exit "$EXIT_USAGE"
fi

URL="${BASE_URL%/}/evidence/${ARCHIVE}"
TMP="${OUT}.partial"

attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    rm -f "$TMP"
    # --fail: an HTTP error is an error, not a saved error page.
    # --cacert: verify against the pinned certificate. No -k, ever.
    # --resolve: map the certified hostname to the real address so hostname
    #            verification still passes. Empty means normal DNS.
    # --max-time: one attempt cannot hang the run.
    RESOLVE_ARGS=()
    [ -n "${EXPORT_RESOLVE:-}" ] && RESOLVE_ARGS=(--resolve "$EXPORT_RESOLVE")
    if curl --fail --silent --show-error \
            --cacert "$EVIDENCE_CA" \
            "${RESOLVE_ARGS[@]}" \
            --max-time "$TIMEOUT" \
            --header "Authorization: Bearer ${EVIDENCE_TOKEN}" \
            --output "$TMP" \
            "$URL"; then
        if [ ! -s "$TMP" ]; then
            echo "attempt ${attempt}/${ATTEMPTS}: empty archive" >&2
            continue
        fi

        actual="$(sha256sum "$TMP" | awk '{print $1}')"

        if [ "$UNVERIFIED_MODE" -eq 1 ]; then
            # Deliberately admitted, deliberately NOT success.
            if mv "$TMP" "$OUT"; then
                echo "UNVERIFIED export written to ${OUT} (sha256 ${actual})" >&2
                echo "this is not a verified export; the run must be marked incomplete" >&2
                exit "$EXIT_UNVERIFIED"
            fi
            echo "attempt ${attempt}/${ATTEMPTS}: could not move archive into place" >&2
            continue
        fi

        if [ "$actual" != "$EXPECTED_SHA" ]; then
            echo "attempt ${attempt}/${ATTEMPTS}: checksum mismatch (want ${EXPECTED_SHA}, got ${actual})" >&2
            continue
        fi

        # Checksum matched; the export is only verified once the bytes are
        # actually in place. A failed move is a failed export, not a success.
        if ! mv "$TMP" "$OUT"; then
            echo "attempt ${attempt}/${ATTEMPTS}: checksum matched but could not move archive into place" >&2
            continue
        fi
        if [ ! -s "$OUT" ]; then
            echo "attempt ${attempt}/${ATTEMPTS}: archive missing or empty after move" >&2
            continue
        fi
        echo "exported ${OUT} (sha256 ${actual}, verified)"
        exit 0
    else
        echo "attempt ${attempt}/${ATTEMPTS}: fetch failed" >&2
    fi
    if [ "$attempt" -lt "$ATTEMPTS" ]; then
        sleep $((attempt * 3))
    fi
done

rm -f "$TMP"
echo "evidence export FAILED after ${ATTEMPTS} attempts: ${URL}" >&2
echo "the caller must keep partial runner evidence, clean up, and mark the run incomplete" >&2
exit "$EXIT_FAILED"
