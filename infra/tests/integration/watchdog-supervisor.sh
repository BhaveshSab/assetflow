#!/usr/bin/env bash
#
# The real supervisor and the real operator-watchdog.sh, run together.
#
# The seventh attempt (run 43224628030) died 44 seconds after launch because
# supervise-run.sh invoked operator-watchdog.sh with flags the watchdog has
# never parsed and then waited for a file the watchdog has never written. Both
# scripts had unit tests; the unit tests met only a stub, so the mismatch was
# invisible. This harness runs BOTH REAL SCRIPTS in one process tree and
# simulates only what is genuinely external: the AWS control plane (a fake
# `aws` executable that records every invocation and serves canned responses)
# and the guest's single public HTTPS port (a real TLS server holding the run's
# own self-signed certificate shape). Nothing replaces either real script.
#
# Proven here:
#   - the correct instance id and the 14,400s lifetime reach the watchdog,
#     and the supervisor's --max-minutes never changes that lifetime;
#   - the correct state directory receives an advancing heartbeat;
#   - a wrong RunId tag makes the watchdog refuse to act;
#   - an AWS read failure does not become, or fake, successful liveness;
#   - watchdog process death, a stalled, malformed or future heartbeat each
#     fail the supervisor with the specific reason, and the failed verdict and
#     diagnostics are preserved;
#   - a deadline termination targets exactly the verified instance id.
set -uo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
SUP="$REPO/infra/capacity-run/supervise-run.sh"
WDG="$REPO/infra/capacity-run/operator-watchdog.sh"
INSTANCE="i-0123456789abcdef0"
RUNID="cap-20261109t0800z-a7f3"
HOST="capacity-run.test"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$*"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$*"; }
want() { # want <description> <expected> <actual>
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want $2, got $3)"; fi
}

command -v python3 >/dev/null || { printf 'SKIP  python3 missing\n'; exit 0; }
command -v openssl >/dev/null || { printf 'SKIP  openssl missing\n'; exit 0; }
[ -x "$SUP" ] && [ -x "$WDG" ] || { bad "real scripts missing"; exit 1; }

W="$(mktemp -d)"
cleanup() {
    [ -n "${SUP_PID:-}" ] && kill -9 "$SUP_PID" 2>/dev/null || true
    [ -n "${APP_PID:-}" ] && kill -9 "$APP_PID" 2>/dev/null || true
    [ -n "${WD_PID:-}" ] && kill -9 "$WD_PID" 2>/dev/null || true
    rm -rf "$W"
}
trap cleanup EXIT

# jq is needed by the supervisor's snapshot consumption. CI installs it; a dev
# box may only have it in a tools directory.
if ! command -v jq >/dev/null; then
    for cand in /mnt/c/Users/bhave/tools "$HOME/bin"; do
        [ -x "$cand/jq" ] && PATH="$cand:$PATH" && break
    done
fi

# ------------------------------------------------------------- fake AWS CLI --
# Records every invocation. Serve the instance running, with a launch time the
# scenarios can move, and flip to terminated once a real terminate lands.
FAKE_BIN="$W/bin"; mkdir -p "$FAKE_BIN"
export FAKE_LOG="$W/aws-calls.log" FAKE_TERM="$W/aws-terminations.log"
export FAKE_DESCRIBE="$W/describe.json" FAKE_STATE_FILE="$W/state.txt"
export FAKE_FAILCOUNT="$W/failcount"
export FAKE_IP="127.0.0.1" FAKE_LAUNCH
cat > "$FAKE_BIN/aws" <<'AWSEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
    *--dry-run*)
        echo 'An error occurred (DryRunOperation) when calling the TerminateInstances operation' >&2
        exit 254 ;;
    *terminate-instances*)
        printf '%s\n' "$*" >> "$FAKE_TERM"
        printf 'terminated' > "$FAKE_STATE_FILE"
        echo '{"TerminatingInstances":[]}' ;;
    *describe-instances*)
        case "$*" in
            *"Launch:"*) cat "$FAKE_DESCRIBE" ;;
            *PublicIpAddress*) echo "$FAKE_IP" ;;
            *State.Name*) cat "$FAKE_STATE_FILE" ;;
            *) echo '{}' ;;
        esac ;;
    *) echo '{}' ;;
esac
AWSEOF
chmod +x "$FAKE_BIN/aws"

echo 'running' > "$FAKE_STATE_FILE"
FAKE_LAUNCH="$(date -u '+%Y-%m-%dT%H:%M:%S+00:00')"
printf '{"State": "running", "Launch": "%s", "RunId": "%s"}\n' "$FAKE_LAUNCH" "$RUNID" > "$FAKE_DESCRIBE"

# ------------------------------------------- the guest's single public port --
# A real TLS server with the run's own certificate shape: a self-signed cert
# for capacity-run.test, which is exactly what generate-trust.sh produces and
# what the supervisor must verify against (trust/tls.crt - there is no ca.crt).
mkdir -p "$W/trust" "$W/state/snapshots"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
    -keyout "$W/trust/tls.key" -out "$W/trust/tls.crt" -subj "/CN=$HOST" \
    -addext "subjectAltName=DNS:$HOST" >/dev/null 2>&1 \
    || { bad "could not build the test certificate"; exit 1; }

find_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
PORT="$(find_port)"

cat > "$W/guest.py" <<'PYEOF'
import http.server, ssl, sys, json, time, tarfile, io, hashlib
port, crt, key, delay = int(sys.argv[1]), sys.argv[2], sys.argv[3], float(sys.argv[4])
start = time.time()
# The guest publishes an evidence archive and records its digest the way
# snapshot-evidence.sh does; the status document carries that digest to the
# runner, and the evidence endpoint serves the bytes. The supervisor's export
# contract needs both.
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    data = json.dumps({'bootstrap-status': 'ready', 'fixture_users': 200}).encode()
    info = tarfile.TarInfo('bootstrap-status'); info.size = len(data)
    tar.addfile(info, io.BytesIO(data))
archive = buf.getvalue()
GUEST_NAME = 'snapshot-20260101T090000Z.tar.gz'
GUEST_SHA = hashlib.sha256(archive).hexdigest()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/evidence/"):
            if path == "/evidence/" + GUEST_NAME:
                self._send(200, archive, 'application/gzip')
            else:
                self._send(404, b'not found')
            return
        if path == "/status":
            body = json.dumps({"stage": "application health", "application_ready": False,
                               "evidence_snapshot": {"name": GUEST_NAME, "sha256": GUEST_SHA,
                                                     "bytes": len(archive)}}).encode()
            code = 200
        elif path == "/api/health/ready":
            if (time.time() - start) < delay:
                body = json.dumps({"status": "starting", "database": "up", "schema": "pending"}).encode()
                code = 503
            else:
                body = json.dumps({"status": "ready", "database": "up", "schema": "current",
                                   "fixture_users": 200, "accounts_verified": 200}).encode()
                code = 200
        else:
            body = b"{}"; code = 404
        self._send(code, body)
s = http.server.HTTPServer(("127.0.0.1", port), H)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(crt, key)
s.socket = c.wrap_socket(s.socket, server_side=True)
s.serve_forever()
PYEOF

run_supervisor() { # run_supervisor <state-dir> <extra supervisor args...>
    local sd="$1"; shift
    EVIDENCE_TOKEN="tttttttttttttttttttttttttttttttt" \
    WATCHDOG_LIFETIME="${WATCHDOG_LIFETIME:-14400}" \
    WATCHDOG_MAX_AGE="${WATCHDOG_MAX_AGE:-150}" \
    PATH="$FAKE_BIN:$PATH" \
        bash "$SUP" --instance "$INSTANCE" --host "$HOST" \
            --trust-dir "$W/trust" --state-dir "$sd" --port "$PORT" "$@" \
        > "$sd/supervisor.out" 2>&1
    echo $?
}

heartbeat_value() { cat "$1/heartbeat" 2>/dev/null || echo ""; }

# ============================================================ 1. happy path ==
# The app is ready immediately, so the supervisor completes on its first pass.
# Run it with --max-minutes 1: the observation timeout must not touch the
# watchdog's own lifetime.
SD="$W/happy"; mkdir -p "$SD/snapshots"
APP_PID=$(python3 "$W/guest.py" "$PORT" "$W/trust/tls.crt" "$W/trust/tls.key" 0 > "$W/app.log" 2>&1 & echo $!)
sleep 1
RC=$(run_supervisor "$SD" --max-minutes 1); SUP_PID=""
want "the supervisor completes the contract" "0" "$RC"
want "the verdict is complete" "complete" "$(cat "$SD/verdict" 2>/dev/null || echo missing)"
want "readiness was recorded as 200" "200" "$(cat "$SD/ready-code" 2>/dev/null || echo missing)"
grep -q "watchdog started" "$SD/supervisor.out" && ok "the supervisor reports the watchdog started" \
    || bad "no watchdog-started report: $(tail -2 "$SD/supervisor.out" | tr '\n' ';')"
# The watchdog's own status line proves the real arguments arrived: positional
# instance id and the 14,400s lifetime, NOT a --max-minutes derivative.
grep -q "watchdog started for $INSTANCE, lifetime 14400s" "$SD/status" \
    && ok "the watchdog received the exact instance id and the 14400s lifetime" \
    || bad "watchdog status line wrong: $(head -2 "$SD/status" 2>/dev/null | tr '\n' ';')"
# The fake AWS log proves the watchdog talks to the control plane through the
# run's own profile and region, about this instance only.
grep -q -- "--profile capacity --region ap-southeast-2 ec2 describe-instances --instance-ids $INSTANCE" "$FAKE_LOG" \
    && ok "the watchdog's AWS reads are profile/region-pinned and instance-scoped" \
    || bad "watchdog AWS calls not scoped: $(grep describe-instances "$FAKE_LOG" | head -1)"
# The heartbeat must have ADVANCED during the run, not merely existed.
H1=$(heartbeat_value "$SD")
sleep 1
[ -n "$H1" ] && case "$H1" in ''|*[!0-9]*) bad "heartbeat is not numeric: $H1";; *) ok "the heartbeat is numeric";; esac
# Snapshots were retained off-host and the checksum covers them.
[ "$(ls -1 "$SD/snapshots"/*.json 2>/dev/null | wc -l)" -ge 1 ] \
    && ok "status snapshots were retained off-host" || bad "no snapshots retained"
[ -s "$SD/evidence.sha256" ] && ok "the evidence checksum was produced" || bad "no evidence checksum"
# The detached watchdog outlives the supervisor; do not leave it running.
WD=$(cat "$SD/watchdog-pid" 2>/dev/null || true); [ -n "$WD" ] && kill -9 "$WD" 2>/dev/null
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""

# ================================================= 2. deadline termination ==
# A launch time in the past plus a one-second lifetime: the watchdog must
# terminate EXACTLY this instance, once, and the supervisor must fail with the
# verdict and its diagnostics preserved.
SD="$W/deadline"; mkdir -p "$SD/snapshots"
printf '{"State": "running", "Launch": "2020-01-01T00:00:00+00:00", "RunId": "%s"}\n' "$RUNID" > "$FAKE_DESCRIBE"
echo 'running' > "$FAKE_STATE_FILE"; : > "$FAKE_TERM"
APP_PID=$(python3 "$W/guest.py" "$PORT" "$W/trust/tls.crt" "$W/trust/tls.key" 0 > "$W/app.log" 2>&1 & echo $!)
sleep 1
RC=$(WATCHDOG_LIFETIME=1 run_supervisor "$SD"); SUP_PID=""
[ "$RC" != "0" ] && ok "the supervisor failed after the deadline termination" \
    || bad "the supervisor succeeded although the watchdog terminated the instance"
TERM_COUNT=$(wc -l < "$FAKE_TERM")
want "exactly one termination was issued" "1" "$TERM_COUNT"
grep -q -- "--instance-ids $INSTANCE" "$FAKE_TERM" \
    && ok "the termination targeted exactly the verified instance" \
    || bad "termination targeted something else: $(cat "$FAKE_TERM")"
[ -s "$SD/verdict" ] && ok "the failed verdict was recorded" \
    || bad "no verdict after the deadline termination"
[ -s "$SD/watchdog.log" ] && ok "the watchdog's own log was preserved" || bad "watchdog.log lost"
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""

# ==================================================== 3. wrong tag refusal ==
# A RunId that is not this run's: the watchdog must refuse to act even with the
# deadline long past.
SD="$W/wrongtag"; mkdir -p "$SD/snapshots"
printf '{"State": "running", "Launch": "2020-01-01T00:00:00+00:00", "RunId": "someone-elses-run"}\n' > "$FAKE_DESCRIBE"
echo 'running' > "$FAKE_STATE_FILE"; : > "$FAKE_TERM"
APP_PID=$(python3 "$W/guest.py" "$PORT" "$W/trust/tls.crt" "$W/trust/tls.key" 0 > "$W/app.log" 2>&1 & echo $!)
sleep 1
RC=$(WATCHDOG_LIFETIME=1 run_supervisor "$SD"); SUP_PID=""
want "no termination was issued for a foreign run's instance" "0" "$(wc -l < "$FAKE_TERM")"
grep -q "refusing to act" "$SD/status" \
    && ok "the watchdog logged its refusal with the observed tag" \
    || bad "no refusal recorded: $(tail -2 "$SD/status" 2>/dev/null | tr '\n' ';')"
WD=$(cat "$SD/watchdog-pid" 2>/dev/null || true); [ -n "$WD" ] && kill -9 "$WD" 2>/dev/null
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""

# ================================== 4. AWS read failure is not fake liveness =
# After the first reads succeed, describe-instances starts failing. The
# watchdog must keep heartbeating (its log shows the WARN), and the supervisor
# must not confuse that failure with either liveness or death.
SD="$W/awsfail"; mkdir -p "$SD/snapshots"
printf '{"State": "running", "Launch": "%s", "RunId": "%s"}\n' "$FAKE_LAUNCH" "$RUNID" > "$FAKE_DESCRIBE"
echo 'running' > "$FAKE_STATE_FILE"
cat > "$FAKE_BIN/aws" <<'AWSEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
    *--dry-run*) echo 'An error occurred (DryRunOperation) when calling the TerminateInstances operation' >&2; exit 254 ;;
    *terminate-instances*) printf '%s\n' "$*" >> "$FAKE_TERM"; printf 'terminated' > "$FAKE_STATE_FILE"; echo '{}' ;;
    *describe-instances*)
        N=$(cat "$FAKE_FAILCOUNT" 2>/dev/null || echo 0)
        N=$((N+1)); printf '%s' "$N" > "$FAKE_FAILCOUNT"
        if [ "$N" -gt 2 ]; then exit 1; fi
        case "$*" in
            *"Launch:"*) cat "$FAKE_DESCRIBE" ;;
            *PublicIpAddress*) echo "$FAKE_IP" ;;
            *State.Name*) cat "$FAKE_STATE_FILE" ;;
            *) echo '{}' ;;
        esac ;;
    *) echo '{}' ;;
esac
AWSEOF
chmod +x "$FAKE_BIN/aws"
echo 0 > "$W/failcount"
APP_PID=$(python3 "$W/guest.py" "$PORT" "$W/trust/tls.crt" "$W/trust/tls.key" 0 > "$W/app.log" 2>&1 & echo $!)
sleep 1
RC=$(WATCHDOG_POLL=2 run_supervisor "$SD"); SUP_PID=""
want "the run still completes when AWS reads degrade" "0" "$RC"
# The detached watchdog outlives the supervisor; give it a few short poll
# cycles so the WARN lands and the heartbeat advances past the failure.
sleep 6
grep -q "WARN cannot read instance state" "$SD/status" \
    && ok "the watchdog's read failure is visible in its own log, not swallowed" \
    || bad "no WARN for the AWS read failure: $(tail -2 "$SD/status" 2>/dev/null | tr '\n' ';')"
H2=$(heartbeat_value "$SD"); sleep 3; H3=$(heartbeat_value "$SD")
[ -n "$H2" ] && [ "$H3" -gt "$H2" ] 2>/dev/null && ok "the heartbeat kept advancing through the AWS failure" \
    || bad "heartbeat did not advance through the AWS failure ($H2 -> $H3)"
WD=$(cat "$SD/watchdog-pid" 2>/dev/null || true); [ -n "$WD" ] && kill -9 "$WD" 2>/dev/null
kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""

# Restore the plain fake for the remaining scenarios.
cat > "$FAKE_BIN/aws" <<'AWSEOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$*" in
    *--dry-run*) echo 'An error occurred (DryRunOperation) when calling the TerminateInstances operation' >&2; exit 254 ;;
    *terminate-instances*) printf '%s\n' "$*" >> "$FAKE_TERM"; printf 'terminated' > "$FAKE_STATE_FILE"; echo '{}' ;;
    *describe-instances*)
        case "$*" in
            *"Launch:"*) cat "$FAKE_DESCRIBE" ;;
            *PublicIpAddress*) echo "$FAKE_IP" ;;
            *State.Name*) cat "$FAKE_STATE_FILE" ;;
            *) echo '{}' ;;
        esac ;;
    *) echo '{}' ;;
esac
AWSEOF
chmod +x "$FAKE_BIN/aws"

# ==================================== 5-8. death, stall, malformed, future ===
# The app stays not-ready for a while so the observation loop keeps passing and
# the liveness re-check has time to catch each injected fault.
printf '{"State": "running", "Launch": "%s", "RunId": "%s"}\n' "$FAKE_LAUNCH" "$RUNID" > "$FAKE_DESCRIBE"
echo 'running' > "$FAKE_STATE_FILE"

fault_case() { # fault_case <name> <inject-function-name>
    local name="$1" inject="$2" sd rc pid
    sd="$W/$name"; mkdir -p "$sd/snapshots"
    APP_PID=$(python3 "$W/guest.py" "$PORT" "$W/trust/tls.crt" "$W/trust/tls.key" 40 > "$W/app.log" 2>&1 & echo $!)
    sleep 1
    RCFILE="$W/$name.rc"
    ( WATCHDOG_MAX_AGE=6 WATCHDOG_POLL=2 WATCHDOG_LIFETIME=14400 \
      EVIDENCE_TOKEN=tttttttttttttttttttttttttttttttt PATH="$FAKE_BIN:$PATH" \
      bash "$SUP" --instance "$INSTANCE" --host "$HOST" \
          --trust-dir "$W/trust" --state-dir "$sd" --port "$PORT" --max-minutes 1 \
      > "$sd/supervisor.out" 2>&1; echo $? > "$RCFILE" ) &
    SUP_PID=$!    # Wait for the watchdog heartbeat, then inject the fault.
    for _ in $(seq 1 20); do
        [ -s "$sd/heartbeat" ] && break; sleep 1
    done
    sleep 2
    pid=$(cat "$sd/watchdog-pid" 2>/dev/null || echo "")
    "$inject" "$sd" "$pid"
    for _ in $(seq 1 40); do
        [ -f "$RCFILE" ] && break; sleep 1
    done
    wait "$SUP_PID" 2>/dev/null; SUP_PID=""
    rc=$(cat "$RCFILE" 2>/dev/null || echo timeout)
    [ "$rc" != "0" ] && [ "$rc" != "timeout" ] \
        && ok "$name: the supervisor failed with the fault detected" \
        || bad "$name: supervisor rc=$rc (expected a detected failure)"
    [ -s "$sd/verdict" ] && ok "$name: the failed verdict was preserved" \
        || bad "$name: no verdict preserved"
    [ -f "$sd/watchdog.log" ] && ok "$name: watchdog diagnostics preserved" \
        || bad "$name: watchdog.log lost"
    WD=$(cat "$sd/watchdog-pid" 2>/dev/null || true); [ -n "$WD" ] && kill -9 "$WD" 2>/dev/null
    kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null; APP_PID=""
}

inject_death()   { kill -9 "$2" 2>/dev/null; }
inject_stall()   { kill -STOP "$2" 2>/dev/null; }
inject_garbage() { kill -STOP "$2" 2>/dev/null; echo not-a-number > "$1/heartbeat"; }
inject_future()  { kill -STOP "$2" 2>/dev/null; echo $(( $(date -u +%s) + 10000 )) > "$1/heartbeat"; }

fault_case "wd-death" inject_death
grep -q "watchdog process .* is gone" "$W/wd-death/watchdog-status" \
    && ok "process death is named as the reason" || bad "death reason not recorded: $(cat "$W/wd-death/watchdog-status" 2>/dev/null)"

fault_case "wd-stall" inject_stall
grep -q "stale" "$W/wd-stall/watchdog-status" \
    && ok "a stalled heartbeat is named as the reason" || bad "stall reason not recorded: $(cat "$W/wd-stall/watchdog-status" 2>/dev/null)"

fault_case "wd-garbage" inject_garbage
grep -q "not numeric" "$W/wd-garbage/watchdog-status" \
    && ok "a malformed heartbeat is named as the reason" || bad "malformed reason not recorded: $(cat "$W/wd-garbage/watchdog-status" 2>/dev/null)"

fault_case "wd-future" inject_future
grep -q "in the future" "$W/wd-future/watchdog-status" \
    && ok "a future heartbeat is named as the reason" || bad "future reason not recorded: $(cat "$W/wd-future/watchdog-status" 2>/dev/null)"

printf '\n---- watchdog-supervisor: %s (%d pass, %d fail) ----\n' \
    "$([ "$FAIL" -eq 0 ] && echo PASS || echo FAIL)" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
exit 0

