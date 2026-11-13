"""Contract tests for the supervisor, executed against real TLS and HTTP.

These do not reimplement the supervisor's logic. They run the actual
`infra/capacity-run/supervise-run.sh` as a subprocess, against real certificates
and a real HTTPS server, with only the AWS control plane simulated.

The run that motivated them (`43007413527`) failed because the supervisor waited
for `application_ready`, a field bootstrap-status.py hard-codes to false, so it
could never pass and reported success anyway. Each test below pins one part of
the corrected contract.

Skipped when curl, openssl or python3 is unavailable.
"""

import os
import pathlib
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SUPERVISOR = ROOT / "infra" / "capacity-run" / "supervise-run.sh"

HAVE = all(shutil.which(t) for t in ("bash", "openssl", "curl", "python3"))

CERT_SCRIPT = r"""
set -e
W="$1"; HOST="$2"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 1 \
  -keyout "$W/ca.key" -out "$W/ca.crt" -subj "/CN=test-ca" \
  -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -keyout "$W/srv.key" -out "$W/srv.csr" -subj "/CN=$HOST" >/dev/null 2>&1
printf 'subjectAltName=DNS:%s\nbasicConstraints=CA:FALSE\n' "$HOST" > "$W/ext"
openssl x509 -req -in "$W/srv.csr" -CA "$W/ca.crt" -CAkey "$W/ca.key" \
  -CAcreateserial -out "$W/srv.crt" -days 1 -extfile "$W/ext" >/dev/null 2>&1
"""

APP = r"""
import http.server, ssl, sys, json, time, tarfile, hashlib, io, os
port, crt, key, become, mode, meta_path, token = (
    sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5],
    sys.argv[6], sys.argv[7])
start = time.time()
# Build the guest archive the publisher would have built, and record its digest
# the way snapshot-evidence.sh does. The runner must learn the digest from the
# status document (the poller stub embeds it), then verify the downloaded bytes
# against it with the real export client.
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode='w:gz') as tar:
    data = json.dumps({'bootstrap-status': 'ready', 'fixture_users': 200}).encode()
    import tarfile as _t
    info = _t.TarInfo('bootstrap-status'); info.size = len(data)
    tar.addfile(info, io.BytesIO(data))
archive = buf.getvalue()
digest = hashlib.sha256(archive).hexdigest()
with open(meta_path, 'w') as fh:
    json.dump({'name': 'snapshot-20260101T090000Z.tar.gz', 'sha256': digest,
               'bytes': len(archive)}, fh)
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body, ctype='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        path = self.path.split('?')[0]
        if path.startswith('/evidence/'):
            if self.headers.get('Authorization', '') != 'Bearer ' + token:
                self._send(401, b'unauthorised'); return
            if path == '/evidence/snapshot-20260101T090000Z.tar.gz':
                self._send(200, archive, 'application/gzip')
            else:
                self._send(404, b'not found')
            return
        if path != '/api/health/ready':
            self._send(404, b'{}'); return
        if (time.time() - start) < become:
            body, code = {"status": "not-ready", "database": "down"}, 503
        else:
            body = {"status": "ready", "database": "up", "schema": "current"}
            # The real application's readiness document carries status,
            # database and schema only - the seeded count travels on the
            # status channel (bootstrap-status.py fixture_users), not here.
            code = 200
        self._send(code, json.dumps(body).encode())
s = http.server.HTTPServer(("127.0.0.1", int(port)), H)
c = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); c.load_cert_chain(crt, key)
s.socket = c.wrap_socket(s.socket, server_side=True)
s.serve_forever()
"""


@unittest.skipUnless(HAVE, "needs bash, openssl, curl and python3")
class SupervisorContract(unittest.TestCase):
    HOST = "capacity-run.test"

    def _run(self, case):
        """Run the real supervisor. Returns (returncode, output, state_dir)."""
        W = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, W, True)
        host = self.HOST
        # A unique port per test: a fixed port collides with the previous
        # test's server, which is still shutting down.
        import socket
        with socket.socket() as sk:
            sk.bind(("127.0.0.1", 0))
            port = str(sk.getsockname()[1])

        subprocess.run(["bash", "-c", CERT_SCRIPT, "-", W, host], check=True,
                       capture_output=True)

        (pathlib.Path(W) / "trust").mkdir()
        # The run's trust material is the self-signed tls.crt (generate-trust.sh
        # produces no separate ca.crt); the supervisor must verify against it.
        shutil.copy(pathlib.Path(W) / "ca.crt", pathlib.Path(W) / "trust" / "tls.crt")
        state = pathlib.Path(W) / "state"
        (state / "snapshots").mkdir(parents=True)

        crt, key = str(pathlib.Path(W) / "srv.crt"), str(pathlib.Path(W) / "srv.key")
        if case == "wrong_ca":
            # A certificate from a different CA. The client must refuse it.
            subprocess.run(["bash", "-c", textwrap.dedent(f"""
                cd {W}
                openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
                  -nodes -days 1 -keyout o.key -out o.crt -subj "/CN={host}" \
                  -addext "subjectAltName=DNS:{host}" >/dev/null 2>&1
            """)], check=True)
            crt, key = str(pathlib.Path(W) / "o.crt"), str(pathlib.Path(W) / "o.key")

        become = {"app_ready": 2, "complete": 2, "p3_denied": 2,
                  "no_fixtures": 2}.get(case, 999999)
        mode = "nofixtures" if case == "no_fixtures" else "ready"
        meta_path = str(pathlib.Path(W) / "guest-meta.json")
        app = subprocess.Popen(["python3", "-c", APP, port, crt, key, str(become), mode,
                                meta_path, "t" * 32],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(app.kill)

        # Simulated AWS control plane; the only thing faked.
        aws = state.parent / "aws-context.sh"
        aws.write_text(textwrap.dedent(f"""
            cap_aws() {{
              case "$*" in
                *--dry-run*)
                  if [ "{case}" = "p3_denied" ]; then
                    echo "UnauthorizedOperation" >&2; return 255; fi
                  echo DryRunOperation >&2; return 255 ;;
                *terminate-instances*) return 0 ;;
                *PublicIpAddress*) echo 127.0.0.1 ;;
                *State.Name*) echo running ;;
                *) return 0 ;;
              esac
            }}
        """))

        # The stub emulates the REAL operator-watchdog.sh interface: positional
        # <instance-id> [lifetime-seconds], state in WATCHDOG_STATE_DIR, and a
        # numeric heartbeat written every cycle - atomically, like the real
        # watchdog, so the supervisor's liveness check can never observe the
        # truncated instant of a plain ">" redirect (a torn read reads as a
        # missing or non-numeric heartbeat and fails the run; on a fast runner
        # with a 2s poll this actually happened in CI).
        (state.parent / "operator-watchdog.sh").write_text(
            "#!/usr/bin/env bash\n"
            'SD="${WATCHDOG_STATE_DIR:?}"\n'
            'mkdir -p "$SD"; echo $$ > "$SD/pid"\n'
            'while :; do date -u +%s > "$SD/.hb.$$" && mv -f "$SD/.hb.$$" "$SD/heartbeat"; sleep 2; done\n')
        (state.parent / "operator-watchdog.sh").chmod(0o755)
        stub = ROOT / "infra" / "tests" / "fixtures" / "poller_stub.sh"
        shutil.copy(stub, state.parent / "poll-status.sh")
        if case == "never_with_bad_snapshot":
            # Present from the start, so the supervisor certainly sees it.
            (state / "snapshots" / "20260101T000000Z-status.json").write_text('{"stage": "trunc')
        (state.parent / "poll-status.sh").chmod(0o755)
        # The REAL export client runs in the sandbox: the supervisor will find
        # it next to itself and download the guest archive the fake app serves,
        # verifying the downloaded bytes against the digest the status document
        # supplied - the same independently-supplied-checksum contract as the
        # real run, over real TLS with the bearer token.
        shutil.copy(ROOT / "infra" / "scripts" / "export-evidence.sh",
                    state.parent / "export-evidence.sh")
        (state.parent / "export-evidence.sh").chmod(0o755)
        shutil.copy(SUPERVISOR, state.parent / "supervise-run.sh")

        # The supervisor needs jq. CI installs it; a dev box may not have it on
        # PATH, so fall back to a locally provided copy if one is present.
        env = dict(os.environ, EVIDENCE_TOKEN="t" * 32)
        if not shutil.which("jq"):
            for cand in ("/mnt/c/Users/bhave/tools", os.path.expanduser("~/bin")):
                if os.path.isfile(os.path.join(cand, "jq")):
                    env["PATH"] = cand + os.pathsep + env.get("PATH", "")
                    break
        # The poller stub embeds the guest-supplied digest into its snapshot,
        # exactly as the real status document would carry it.
        env["GUEST_META"] = meta_path
        # The no_fixtures case models a run whose seed never wrote a count:
        # the status document then carries fixture_users 0, and the contract
        # check must fail on it rather than going looking for a friendlier
        # number.
        env["STUB_FIXTURE_USERS"] = "0" if case == "no_fixtures" else "200"
        if not shutil.which("jq"):
            for cand in ("/mnt/c/Users/bhave/tools", os.path.expanduser("~/bin")):
                if os.path.isfile(os.path.join(cand, "jq")):
                    env["PATH"] = cand + os.pathsep + env.get("PATH", "")
                    break
        proc = subprocess.run(
            ["bash", str(state.parent / "supervise-run.sh"),
             "--instance", "i-0123456789abcdef0", "--host", host,
             "--trust-dir", str(pathlib.Path(W) / "trust"),
             "--state-dir", str(state), "--max-minutes", "1", "--port", port],
            capture_output=True, text=True, env=env, timeout=180)
        return proc.returncode, proc.stdout + proc.stderr, state

    # ---- the deadlock that caused the failure --------------------------
    def test_diagnostic_ready_false_does_not_block_a_healthy_app(self):
        """The defect that killed run 43007413527.

        bootstrap-status.py hard-codes application_ready=false. The old
        supervisor waited for it to become true, so it could never pass and the
        run was terminated for nothing. Here the diagnostic document says false
        throughout while the real route says 200 - readiness must be taken from
        the route, and the run must pass.
        """
        rc, out, state = self._run("app_ready")
        self.assertIn("HTTP 200", out)
        self.assertEqual(rc, 0, out)
        self.assertEqual((state / "verdict").read_text().strip(), "complete")
        # The snapshot the poller wrote still says false, and was not a gate.
        snap = sorted((state / "snapshots").glob("*-status.json"))[0]
        self.assertIn('"application_ready": false', snap.read_text().replace('"application_ready":false', '"application_ready": false'))

    def test_app_never_ready_fails_nonzero(self):
        rc, out, state = self._run("never")
        self.assertEqual(rc, 3, out)
        self.assertIn("not reached", (state / "verdict").read_text())

    def test_wrong_ca_is_never_a_false_success(self):
        rc, out, _ = self._run("wrong_ca")
        self.assertNotEqual(rc, 0, out)
        self.assertNotIn("HTTP 200", out)

    def test_p3_refusal_stops_the_run(self):
        rc, out, _ = self._run("p3_denied")
        self.assertEqual(rc, 1, out)
        self.assertIn("P3", out)

    def test_missing_fixtures_is_not_a_stage3_pass(self):
        rc, out, _ = self._run("no_fixtures")
        self.assertEqual(rc, 5, out)
        self.assertIn("fixtures", out)

    def test_complete_contract_exits_zero(self):
        rc, out, _ = self._run("complete")
        self.assertEqual(rc, 0, out)
        for check in ("database == up", "schema == current", "fixtures seeded",
                      "metrics retained", "evidence checksum"):
            self.assertIn(check, out)

    # ---- snapshot handling ---------------------------------------------
    def test_malformed_snapshot_is_skipped_not_trusted(self):
        """A truncated snapshot must be reported and ignored, never read as
        progress or as readiness, and must not stop the run from failing
        honestly."""
        rc, out, _ = self._run("never_with_bad_snapshot")
        self.assertEqual(rc, 3, out)
        self.assertIn("not valid JSON", out)
        self.assertNotIn("application readiness: HTTP 200", out)

    def test_poller_files_are_never_renamed(self):
        rc, out, state = self._run("never")
        names = sorted(p.name for p in (state / "snapshots").iterdir())
        self.assertFalse([n for n in names if n.startswith("received-")], names)


if __name__ == "__main__":
    unittest.main()
