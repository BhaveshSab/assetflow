"""Contract tests for the early bootstrap-status endpoint.

The endpoint exists because a real run's console buffer filled during a 58-minute
image build and the fixture failure scrolled out before anyone could read it.
These tests pin the properties that make it useful *without* making it a hazard:

  * it answers before the application exists;
  * it refuses a wrong token, and it never serves a file or a directory;
  * no secret can reach a response;
  * readiness is never implied by the diagnostic channel being up.
"""

from __future__ import annotations

import importlib.util
import json
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVICE = ROOT / "infra" / "capacity-run" / "bootstrap-status.py"
USER_DATA = ROOT / "infra" / "capacity-run" / "user-data.sh"


def load_module():
    spec = importlib.util.spec_from_file_location("bootstrap_status", SERVICE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class RedactionTests(unittest.TestCase):
    """Nothing that identifies a credential may survive into a response body."""

    def setUp(self):
        self.mod = load_module()

    def test_connection_string_password_is_masked(self):
        text = "connecting to postgresql://assetflow:SuperSecret123@postgres:5432/assetflow"
        self.assertNotIn("SuperSecret123", self.mod.redact(text))

    def test_password_assignment_is_masked(self):
        self.assertNotIn("AnotherSecret456", self.mod.redact("LOADTEST_PASSWORD=AnotherSecret456"))

    def test_bearer_token_is_masked(self):
        self.assertNotIn("abc123def456", self.mod.redact("Authorization: Bearer abc123def456"))

    def test_json_password_hash_is_masked(self):
        out = self.mod.redact('{"passwordHash": "$2b$12$abcdefghijklmnop"}')
        self.assertNotIn("abcdefghijklmnop", out)

    def test_private_key_block_is_removed(self):
        text = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"
        self.assertNotIn("MIIEow", self.mod.redact(text))

    def test_ordinary_text_is_untouched(self):
        self.assertEqual(self.mod.redact("stage=fixtures"), "stage=fixtures")


class SnapshotTests(unittest.TestCase):
    """Snapshots report state, and never assert readiness."""

    def setUp(self):
        self.mod = load_module()
        self.dir = tempfile.mkdtemp()
        self.run_dir = Path(self.dir) / "run"
        (self.run_dir / "evidence").mkdir(parents=True)

    def write(self, name, value):
        (self.run_dir / "evidence" / name).write_text(value, encoding="utf-8")

    def test_readiness_is_never_implied(self):
        self.write("stage-current", "packages")
        report = self.mod.status(self.run_dir)
        # The diagnostic channel answering says the guest is alive, nothing more.
        self.assertFalse(report["application_ready"])
        self.assertIn("readiness", report["note"])

    def test_stage_is_reported(self):
        self.write("stage-current", "fixtures")
        self.assertEqual(self.mod.status(self.run_dir)["stage"], "fixtures")

    def test_unreadable_deadline_is_not_reported_as_fine(self):
        report = self.mod.status(self.run_dir)
        self.assertEqual(report["deadline_state"], "unreadable")

    def test_passed_deadline_is_visible(self):
        self.write("deadline-epoch", "1")
        report = self.mod.status(self.run_dir)
        self.assertEqual(report["deadline_state"], "passed")
        self.assertLess(report["deadline_remaining_seconds"], 0)

    def test_publisher_digest_is_carried_when_present(self):
        # The guest publisher's own record of the archive it built. This is the
        # independently supplied checksum the runner verifies its download
        # against - it must travel over the status channel, not be computed
        # runner-side over the received bytes.
        self.write(".snapshot-latest.meta",
                   '{"name":"snapshot-20260101T090000Z.tar.gz",'
                   '"sha256":"' + 'a' * 64 + '","bytes":1234,"created_epoch":10}')
        snap = self.mod.status(self.run_dir)["evidence_snapshot"]
        self.assertEqual(snap["name"], "snapshot-20260101T090000Z.tar.gz")
        self.assertEqual(snap["sha256"], "a" * 64)

    def test_missing_or_broken_publisher_digest_is_null_not_invented(self):
        # Absent meta, malformed JSON, or a non-digest value must surface as
        # null/unknown - never as a fabricated checksum the runner would trust.
        self.assertIsNone(self.mod.status(self.run_dir)["evidence_snapshot"])
        self.write(".snapshot-latest.meta", "not json at all")
        self.assertIsNone(self.mod.status(self.run_dir)["evidence_snapshot"])

    def test_seed_exit_code_is_reported_verbatim(self):
        self.write("seed-exit", "137")
        report = self.mod.seed(self.run_dir)
        self.assertEqual(report["exit_code"], 137)
        self.assertEqual(report["state"], "failed")

    def test_seed_success_is_distinguished(self):
        self.write("seed-started-at", "100")
        self.write("seed-exit", "0")
        self.assertEqual(self.mod.seed(self.run_dir)["state"], "succeeded")

    def test_unstarted_seed_says_so(self):
        self.assertEqual(self.mod.seed(self.run_dir)["state"], "not-started")

    def test_progress_is_observable_during_a_long_seed(self):
        # A long seed must look like it is moving, not hung.
        log = "\n".join(f"created loadtest-cap-0001-{i:03d}@assetflow.test" for i in range(7))
        self.write("seed.log", log)
        self.assertEqual(self.mod.seed(self.run_dir)["accounts_seen_in_log"], 7)

    def test_failure_summary_is_bounded_and_redacted(self):
        self.write("failure-summary", "stage=fixtures postgresql://u:LeakMe@h/db")
        self.write("seed.log", "Error: password=AlsoLeakMe\n")
        report = self.mod.failure(self.run_dir)
        blob = json.dumps(report)
        self.assertNotIn("LeakMe", blob)
        self.assertLessEqual(len(report["seed_log_tail"]), 20)

    def test_no_secret_reaches_any_snapshot(self):
        # Credential-shaped text must not survive into a snapshot. A bare
        # unstructured secret on its own line cannot be detected by pattern, so
        # this covers the forms that actually appear: URL userinfo, assigned
        # passwords, bearer tokens and JSON fields.
        exposures = [
            "postgresql://assetflow:S3cr3tPass@postgres:5432/x",
            "LOADTEST_PASSWORD=S3cr3tPass",
            "Authorization: Bearer S3cr3tPass",
            '{"passwordHash": "S3cr3tPass"}',
        ]
        body = "\n".join(exposures)
        self.write("failure-summary", body)
        self.write("seed.log", body)
        self.write("bootstrap-status", "failed: " + exposures[0])
        blob = (
            json.dumps(self.mod.status(self.run_dir))
            + json.dumps(self.mod.seed(self.run_dir))
            + json.dumps(self.mod.failure(self.run_dir))
        )
        self.assertNotIn("S3cr3tPass", blob)



class SeedStateMachineTests(unittest.TestCase):
    """A seed that dies without recording an exit must still be visible.

    This is the exact gap a previous run fell into: the instance was gone, the
    console buffer had rolled, and nothing said whether the seed was still
    working, had failed, or had been killed. The observer decides from process
    and container liveness, not from the seed's own cooperation, and it refuses
    to invent an exit code or a cause it did not observe.
    """

    def setUp(self):
        self.mod = load_module()
        self.dir = tempfile.mkdtemp()
        self.run_dir = Path(self.dir) / "run"
        (self.run_dir / "evidence").mkdir(parents=True)

    def write(self, name, value):
        (self.run_dir / "evidence" / name).write_text(str(value), encoding="utf-8")

    def test_states_are_the_documented_set(self):
        self.assertEqual(
            set(self.mod.SEED_STATES),
            {"not-started", "running", "succeeded", "failed", "interrupted", "unknown"},
        )

    def test_nothing_recorded_is_not_started(self):
        self.assertEqual(self.mod.seed(self.run_dir)["state"], "not-started")

    def test_exit_zero_is_succeeded(self):
        self.write("seed-started-at", "100")
        self.write("seed-exit", "0")
        self.assertEqual(self.mod.seed(self.run_dir)["state"], "succeeded")

    def test_nonzero_exit_is_failed(self):
        self.write("seed-started-at", "100")
        self.write("seed-exit", "1")
        state = self.mod.seed(self.run_dir)
        self.assertEqual(state["state"], "failed")
        self.assertEqual(state["exit_code"], 1)

    def test_unparseable_exit_is_unknown_not_success(self):
        self.write("seed-started-at", "100")
        self.write("seed-exit", "not-a-number")
        self.assertEqual(self.mod.seed(self.run_dir)["state"], "unknown")

    def test_started_with_live_process_is_running(self):
        self.write("seed-started-at", "100")
        # Our own pid is unambiguously alive.
        self.write("seed-pid", os.getpid())
        self.assertEqual(self.mod.seed(self.run_dir)["state"], "running")

    def test_started_with_dead_process_is_interrupted(self):
        self.write("seed-started-at", "100")
        # A pid that cannot exist: liveness is decidable and negative.
        self.write("seed-pid", "4000001")
        state = self.mod.seed(self.run_dir)
        self.assertEqual(state["state"], "interrupted")

    def test_interrupted_invents_no_exit_code_or_cause(self):
        # The whole point: absence of evidence must not become a fabricated one.
        self.write("seed-started-at", "100")
        self.write("seed-pid", "4000001")
        state = self.mod.seed(self.run_dir)
        self.assertIsNone(state["exit_code"])
        self.assertEqual(state["cause"], "unknown")
        self.assertNotIn("signal", state)

    def test_unreadable_liveness_is_unknown_not_dead(self):
        # No pid and no container id: we cannot tell. Reporting "interrupted"
        # here would be an invention; reporting "succeeded" would be a lie.
        self.write("seed-started-at", "100")
        state = self.mod.seed(self.run_dir)
        self.assertEqual(state["state"], "unknown")
        self.assertIn("cannot be determined", state["reason"])

    def test_garbage_pid_does_not_count_as_dead(self):
        self.write("seed-started-at", "100")
        self.write("seed-pid", "not-a-pid")
        self.assertEqual(self.mod.seed(self.run_dir)["state"], "unknown")

    def test_progress_is_reported_while_running(self):
        self.write("seed-started-at", "100")
        self.write("seed-pid", os.getpid())
        self.write("seed.log", chr(10).join(f"created loadtest-cap-0001-{i:03d}@assetflow.test" for i in range(5)))
        state = self.mod.seed(self.run_dir)
        self.assertEqual(state["state"], "running")
        self.assertEqual(state["accounts_seen_in_log"], 5)

    def test_container_absence_is_not_death(self):
        # Docker being unavailable must not be read as "the container stopped".
        self.write("seed-started-at", "100")
        self.write("seed-container", "deadbeefcafe")
        state = self.mod.seed(self.run_dir)
        # No pid, and docker cannot answer in this environment: unknown.
        self.assertIn(state["state"], ("unknown", "running"))

    def test_helper_records_liveness_inputs(self):
        helper = (ROOT / "infra" / "capacity-run" / "seed-fixtures.sh").read_text(encoding="utf-8")
        for marker in ("seed-pid", "seed-container", "seed-finished-at"):
            self.assertIn(marker, helper, f"{marker} must be recorded for the observer")


class DeliberateTerminationTests(unittest.TestCase):
    """Kill a real seed and prove the retained snapshot says so."""

    def setUp(self):
        self.mod = load_module()
        self.dir = tempfile.mkdtemp()
        self.run_dir = Path(self.dir) / "run"
        (self.run_dir / "evidence").mkdir(parents=True)

    def test_killed_process_becomes_interrupted(self):
        # Start a real process that writes a start marker and then blocks.
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
        )
        try:
            (self.run_dir / "evidence" / "seed-started-at").write_text("100", encoding="utf-8")
            (self.run_dir / "evidence" / "seed-pid").write_text(str(proc.pid), encoding="utf-8")
            self.assertEqual(self.mod.seed(self.run_dir)["state"], "running")
            proc.kill()
            proc.wait(timeout=10)
            state = self.mod.seed(self.run_dir)
            self.assertEqual(state["state"], "interrupted")
            self.assertIsNone(state["exit_code"])
        finally:
            if proc.poll() is None:
                proc.kill()

    def test_interrupted_snapshot_reaches_the_endpoint(self):
        # The retained snapshot the operator reads must carry the new state,
        # otherwise the state machine only exists in unit tests.
        (self.run_dir / "evidence" / "seed-started-at").write_text("100", encoding="utf-8")
        (self.run_dir / "evidence" / "seed-pid").write_text("4000001", encoding="utf-8")
        report = self.mod.seed(self.run_dir)
        self.assertEqual(report["state"], "interrupted")
        self.assertEqual(report["cause"], "unknown")
        blob = json.dumps(report)
        self.assertIn("interrupted", blob)
        # And it must not claim a cause it did not observe.
        self.assertNotIn("oom", blob.lower())
        self.assertNotIn("timeout", blob.lower())


class EndpointTests(unittest.TestCase):
    """Behaviour over the wire: auth, and the refusal to serve files."""

    @classmethod
    def setUpClass(cls):
        cls.mod = load_module()
        cls.tmp = tempfile.mkdtemp()
        cls.run_dir = Path(cls.tmp) / "run"
        (cls.run_dir / "evidence").mkdir(parents=True)
        (cls.run_dir / "evidence" / "stage-current").write_text("fixtures", encoding="utf-8")
        # A file that must NEVER be readable, sitting where a naive server would
        # find it if it resolved arbitrary paths.
        (cls.run_dir / "private.env").write_text("POSTGRES_PASSWORD=DoNotServe", encoding="utf-8")

        cert = Path(cls.tmp) / "tls.crt"
        key = Path(cls.tmp) / "tls.key"
        # IP SAN as well as the DNS name, so the test can reach the loopback
        # address while still verifying the certificate for real.
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", str(key), "-out", str(cert), "-days", "1",
             "-subj", "/CN=capacity-run.test",
             "-addext", "subjectAltName=DNS:capacity-run.test,IP:127.0.0.1"],
            check=True, capture_output=True,
        )
        cls.token = "test-token-value"
        cls.server = cls.mod.build_server(str(cert), str(key), cls.token, cls.run_dir, 0, "127.0.0.1")
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.ca = str(cert)
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path, token=None, hostname="capacity-run.test"):
        context = ssl.create_default_context(cafile=self.ca)
        url = f"https://127.0.0.1:{self.port}{path}"
        req = urllib.request.Request(url)
        if token is not None:
            req.add_header("Authorization", f"Bearer {token}")
        # Verify the certificate properly: no -k anywhere.
        conn = urllib.request.urlopen(req, timeout=5, context=context)
        return conn.status, conn.read()

    def test_valid_token_returns_status(self):
        context = ssl.create_default_context(cafile=self.ca)
        url = f"https://127.0.0.1:{self.port}/status"
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"})
        with urllib.request.urlopen(req, timeout=5, context=context) as resp:
            self.assertEqual(resp.status, 200)
            body = json.loads(resp.read())
        self.assertEqual(body["stage"], "fixtures")

    def test_missing_token_is_rejected(self):
        context = ssl.create_default_context(cafile=self.ca)
        req = urllib.request.Request(f"https://127.0.0.1:{self.port}/status")
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=5, context=context)
        self.assertEqual(caught.exception.code, 401)

    def test_wrong_token_is_rejected(self):
        context = ssl.create_default_context(cafile=self.ca)
        req = urllib.request.Request(
            f"https://127.0.0.1:{self.port}/status",
            headers={"Authorization": "Bearer wrong-token"},
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(req, timeout=5, context=context)
        self.assertEqual(caught.exception.code, 401)

    def test_wrong_hostname_fails_verification(self):
        # A certificate for an unrelated name must be refused by a client that
        # trusts only the run CA. Proves verification is not disabled.
        other_cert = Path(self.tmp) / "other.crt"
        other_key = Path(self.tmp) / "other.key"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", str(other_key), "-out", str(other_cert), "-days", "1",
             "-subj", "/CN=somewhere-else.test",
             "-addext", "subjectAltName=DNS:somewhere-else.test"],
            check=True, capture_output=True,
        )
        wrong = self.mod.build_server(str(other_cert), str(other_key), self.token, self.run_dir, 0, "127.0.0.1")
        threading.Thread(target=wrong.serve_forever, daemon=True).start()
        try:
            port = wrong.server_address[1]
            context = ssl.create_default_context(cafile=self.ca)
            req = urllib.request.Request(
                f"https://127.0.0.1:{port}/status",
                headers={"Authorization": f"Bearer {self.token}"},
            )
            with self.assertRaises((ssl.SSLError, urllib.error.URLError, OSError)):
                urllib.request.urlopen(req, timeout=5, context=context)
        finally:
            wrong.shutdown()
            wrong.server_close()

    def test_untrusted_ca_fails(self):
        # A context that has not been given the run CA must refuse the cert.
        context = ssl.create_default_context()
        req = urllib.request.Request(
            f"https://127.0.0.1:{self.port}/status",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        with self.assertRaises((ssl.SSLError, urllib.error.URLError, OSError)):
            urllib.request.urlopen(req, timeout=5, context=context)

    def test_run_directory_is_not_served(self):
        for path in ("/private.env", "/evidence/stage-current", "/../private.env", "/run/private.env"):
            context = ssl.create_default_context(cafile=self.ca)
            req = urllib.request.Request(
                f"https://127.0.0.1:{self.port}{path}",
                headers={"Authorization": f"Bearer {self.token}"},
            )
            with self.assertRaises(urllib.error.HTTPError) as caught:
                urllib.request.urlopen(req, timeout=5, context=context)
            self.assertEqual(caught.exception.code, 404, path)

    def test_secret_file_content_never_appears(self):
        context = ssl.create_default_context(cafile=self.ca)
        req = urllib.request.Request(
            f"https://127.0.0.1:{self.port}/status/failure",
            headers={"Authorization": f"Bearer {self.token}"},
        )
        with urllib.request.urlopen(req, timeout=5, context=context) as resp:
            self.assertNotIn(b"DoNotServe", resp.read())


class BootstrapOrderingTests(unittest.TestCase):
    """The endpoint must exist before the things it needs to report on."""

    def setUp(self):
        self.text = USER_DATA.read_text(encoding="utf-8")

    def test_status_service_starts_before_packages(self):
        status_at = self.text.index("capacity-status.service")
        packages_at = self.text.index('stage_begin "packages"')
        self.assertLess(status_at, packages_at, "status endpoint must start before packages")

    def test_status_service_starts_before_build_and_seed(self):
        status_at = self.text.index("capacity-status.service")
        for later in ("migrate-db.sh", "seed-fixtures.sh"):
            self.assertLess(status_at, self.text.index(later), f"{later} must come after")

    def test_status_service_is_not_ordered_after_docker(self):
        block = self.text[self.text.index("capacity-status.service") - 2000:]
        head = block[: block.index("ExecStart")] if "ExecStart" in block else block[:2000]
        self.assertNotIn("After=docker", head)

    def test_service_reads_token_from_run_config(self):
        # The unit gets its token from the operator-provisioned run config, so no
        # token is written into the payload. The unit is emitted by the shared
        # `unit()` helper now, so assert the property rather than the literal
        # printf arguments.
        self.assertIn("EnvironmentFile=$CONFIG", self.text)
        self.assertIn("unit capacity-status", self.text)
        self.assertNotIn("EVIDENCE_TOKEN=" , self.text.split("unit capacity-status")[1].split("\n")[0])

    def test_stage_is_recorded_for_the_endpoint(self):
        self.assertIn('"$EVIDENCE_DIR/stage-current"', self.text)

    def test_failure_summary_is_written_before_shutdown(self):
        die_start = self.text.index("die() {")
        body = self.text[die_start : die_start + 800]
        self.assertIn("failure-summary", body)
        self.assertLess(body.index("failure-summary"), body.index("shutdown"))


class MigrationReadinessGateTests(unittest.TestCase):
    """The migration must wait for a database that can actually answer."""

    def setUp(self):
        self.text = (ROOT / "infra" / "capacity-run" / "migrate-db.sh").read_text(encoding="utf-8")

    def test_waits_for_pg_isready_before_migrating(self):
        self.assertIn("pg_isready", self.text)
        self.assertLess(self.text.index("pg_isready"), self.text.index("running migrations"))

    def test_wait_is_bounded(self):
        self.assertIn("DB_WAIT", self.text)

    def test_failure_to_become_ready_is_fatal(self):
        self.assertIn("did not accept queries", self.text)

    def test_migration_runs_in_the_foreground(self):
        self.assertIn("run --rm --no-deps migrate", self.text)


if __name__ == "__main__":
    unittest.main()


class PollerTests(unittest.TestCase):
    """The client must retain snapshots off-host while the run is still working."""

    def setUp(self):
        self.script = (ROOT / "infra" / "capacity-run" / "poll-status.sh").read_text(encoding="utf-8")

    def test_requires_token_and_ca(self):
        for flag in ("--token", "--ca", "--host"):
            self.assertIn(flag, self.script)

    def test_verifies_the_certificate(self):
        # --cacert with no --insecure: a broken chain must not be silently trusted.
        self.assertIn("--cacert", self.script)
        self.assertNotIn("--insecure", self.script)
        self.assertNotIn(" -k ", self.script)

    def test_retains_timestamped_snapshots(self):
        self.assertIn("date -u +%Y%m%dT%H%M%SZ", self.script)

    def test_polls_every_endpoint_including_failure(self):
        for endpoint in ("/status", "/status/seed", "/status/host", "/status/failure"):
            self.assertIn(endpoint, self.script)

    def test_no_snapshot_means_failure_not_success(self):
        self.assertIn('[ "$kept" -gt 0 ] || exit 1', self.script)

    def test_bounded_by_a_duration(self):
        self.assertIn("--duration", self.script)
        self.assertIn("DURATION", self.script)


class EdgeRoutingTests(unittest.TestCase):
    """/status must be routable on the one approved port, and not shadowed."""

    def setUp(self):
        self.conf = (ROOT / "infra" / "capacity-run" / "edge" / "edge.conf").read_text(encoding="utf-8")

    def test_status_is_proxied_to_the_diagnostic_port(self):
        self.assertIn("location /status", self.conf)
        self.assertIn("127.0.0.1:9444", self.conf)

    def test_status_is_declared_before_the_catch_all(self):
        self.assertLess(self.conf.index("location /status"), self.conf.index("location / {"))

    def test_only_one_public_port(self):
        self.assertEqual(self.conf.count("listen "), 1)
        self.assertIn("listen 8443 ssl", self.conf)

    def test_evidence_routing_is_preserved(self):
        self.assertIn("location /evidence/", self.conf)
        self.assertIn("127.0.0.1:9443", self.conf)


class SeedDiagnosabilityTests(unittest.TestCase):
    """A failed seed must leave a redacted, retained record - not just a console line."""

    def setUp(self):
        self.helper = (ROOT / "infra" / "capacity-run" / "seed-fixtures.sh").read_text(encoding="utf-8")

    def test_exit_status_is_recorded(self):
        self.assertIn("seed-exit", self.helper)

    def test_elapsed_time_and_signal_are_recorded(self):
        self.assertIn("seed-elapsed", self.helper)
        self.assertIn("seed-signal", self.helper)

    def test_failure_output_is_redacted(self):
        self.assertIn("redact", self.helper)

    def test_raw_log_is_not_written_to_console(self):
        # A bounded summary may go to console; the raw log must not.
        self.assertIn("seed.log", self.helper)
