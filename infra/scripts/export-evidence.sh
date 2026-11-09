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
# Behaviour on failure (agreed with the operator):
#   * bounded retries with backoff - never an unbounded wait;
#   * the caller keeps whatever partial evidence the runner already has;
#   * exit 75 tells the caller "export failed": clean up anyway, and mark the
#     run completed:false. Teardown is never withheld past the 4-hour ceiling.
#
# TLS: the server certificate is verified against a supplied CA/pin file and the
# hostname is checked. There is no --insecure path, and none is accepted.
#
# Environment:
#   EVIDENCE_TOKEN   bearer token (required)
#   EVIDENCE_CA      path to the certificate to trust (required)
#   EXPORT_ATTEMPTS  total attempts (default 5)
#   EXPORT_TIMEOUT   per-attempt timeout in seconds (default 120)

set -uo pipefail

usage() {
    echo "usage: export-evidence.sh <base-url> <archive-name> <sha256|-> <out-file>" >&2
    exit 2
}

[ $# -eq 4 ] || usage
BASE_URL="$1"
ARCHIVE="$2"
EXPECTED_SHA="$3"
OUT="$4"

ATTEMPTS="${EXPORT_ATTEMPTS:-5}"
TIMEOUT="${EXPORT_TIMEOUT:-120}"

[ -n "${EVIDENCE_TOKEN:-}" ] || { echo "EVIDENCE_TOKEN is not set" >&2; exit 2; }
[ -n "${EVIDENCE_CA:-}" ] || { echo "EVIDENCE_CA is not set (refusing to fetch unverified)" >&2; exit 2; }
[ -f "$EVIDENCE_CA" ] || { echo "EVIDENCE_CA does not exist: $EVIDENCE_CA" >&2; exit 2; }
case "$BASE_URL" in
    https://*) ;;
    *) echo "refusing a non-HTTPS evidence URL: $BASE_URL" >&2; exit 2 ;;
esac

URL="${BASE_URL%/}/evidence/${ARCHIVE}"
TMP="${OUT}.partial"

attempt=0
while [ "$attempt" -lt "$ATTEMPTS" ]; do
    attempt=$((attempt + 1))
    rm -f "$TMP"
    # --fail: an HTTP error is an error, not a saved error page.
    # --cacert: verify against the pinned certificate. No -k, ever.
    # --max-time: one attempt cannot hang the run.
    if curl --fail --silent --show-error \
            --cacert "$EVIDENCE_CA" \
            --max-time "$TIMEOUT" \
            --header "Authorization: Bearer ${EVIDENCE_TOKEN}" \
            --output "$TMP" \
            "$URL"; then
        if [ ! -s "$TMP" ]; then
            echo "attempt ${attempt}/${ATTEMPTS}: empty archive" >&2
        elif [ "$EXPECTED_SHA" != "-" ]; then
            actual="$(sha256sum "$TMP" | awk '{print $1}')"
            if [ "$actual" = "$EXPECTED_SHA" ]; then
                mv "$TMP" "$OUT"
                echo "exported ${OUT} (sha256 ${actual})"
                exit 0
            fi
            echo "attempt ${attempt}/${ATTEMPTS}: checksum mismatch (want ${EXPECTED_SHA}, got ${actual})" >&2
        else
            actual="$(sha256sum "$TMP" | awk '{print $1}')"
            mv "$TMP" "$OUT"
            echo "exported ${OUT} (sha256 ${actual}, unverified)" >&2
            exit 0
        fi
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
exit 75
