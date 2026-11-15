"""Integration harness: the real evidence server, real TLS, real readiness script.

Unit tests that stub curl prove nothing about the contract. This suite starts the
actual `evidence_server.py` on a real socket with a real certificate, publishes a
real snapshot tarball the way `snapshot-evidence.sh` does, and then runs the actual
`readiness-check.sh` as a subprocess against it.

That is the only way to catch the defect the reviewer found: readiness requested
`/bootstrap-status`, which the server answers with 404 because it serves only
`/evidence/<name>.tar.gz`. A stubbed test would have passed while the real path
failed.
"""
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import tarfile
import threading
import time
import unittest
from http.client import HTTPSConnection
from pathlib import Path

CAPACITY_DIR = Path(__file__).resolve().parents[2] / 'infra/capacity-run'

CERT_HOST = 'capacity-run.test'

# The renderer now requires the per-run application configuration, because the
# compose file has no defaults for these. Generate them once for the suite.
def _app_env():
    import tempfile
    out = Path(tempfile.mkdtemp()) / 'app.env'
    subprocess.run(['bash', str(CAPACITY_DIR / 'generate-app-config.sh'),
                    str(out), 'cap-test'], check=True, capture_output=True)
    values = {}
    for line in out.read_text().splitlines():
        if '=' in line and not line.startswith('#'):
            k, v = line.split('=', 1)
            values[k] = v
    return values


APP_ENV = _app_env()
SERVER = Path(__file__).resolve().parents[2] / 'infra/scripts/evidence_server.py'
READINESS = CAPACITY_DIR / 'readiness-check.sh'
SNAPSHOT = CAPACITY_DIR / 'snapshot-evidence.sh'

COMMIT = 'a' * 40
TOKEN = 't' * 48


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def make_cert(directory: Path, san: str) -> tuple[Path, Path]:
    directory.mkdir(parents=True, exist_ok=True)
    crt = directory / 'tls.crt'
    key = directory / 'tls.key'
    subprocess.run([
        'openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', str(key), '-out', str(crt),
        '-subj', '/CN=capacity-run', '-addext', f'subjectAltName={san}',
    ], check=True, capture_output=True)
    return crt, key


class ServerHarness:
    """Runs the real evidence server in a thread, then stops it."""

    def __init__(self, evidence_dir: Path, cert: Path, key: Path):
        self.port = free_port()
        self.evidence_dir = evidence_dir
        self.env = dict(os.environ)
        self.env['EVIDENCE_DIR'] = str(evidence_dir)
        self.env['EVIDENCE_TOKEN'] = TOKEN
        self.proc = None
        self.thread = None
        self._cert = cert
        self._key = key

    def __enter__(self):
        self.proc = subprocess.Popen(
            [sys.executable, str(SERVER), '--port', str(self.port),
             '--host', '127.0.0.1', '--cert', str(self._cert), '--key', str(self._key)],
            env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        # Wait for the listener rather than sleeping a fixed time.
        for _ in range(100):
            with socket.socket() as s:
                if s.connect_ex(('127.0.0.1', self.port)) == 0:
                    return self
            time.sleep(0.05)
        self.__exit__(None, None, None)
        raise RuntimeError('server did not start')

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def get(self, path, token=TOKEN):
        ctx = ssl.create_default_context(cafile=str(self._cert))
        # Dial the real address but present the certified hostname, mirroring
        # `curl --resolve`. Hostname verification stays on.
        conn = HTTPSConnection(CERT_HOST, self.port, context=ctx, timeout=10,
                               source_address=None)
        conn._create_connection = lambda *a, **k: __import__('socket').create_connection(
            ('127.0.0.1', self.port), 10)
        headers = {'Authorization': f'Bearer {token}'} if token else {}
        conn.request('GET', path, headers=headers)
        resp = conn.getresponse()
        body = resp.read()
        conn.close()
        return resp.status, body


def write_evidence(directory: Path, **overrides):
    """Write a realistic evidence directory and a snapshot archive of it."""
    directory.mkdir(parents=True, exist_ok=True)
    now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    fields = {
        'bootstrap-status': 'ready',
        'deployed-commit': COMMIT,
        'expected-commit': COMMIT,
        'deadline-epoch': str(int(time.time()) + 3600),
        'deadline-timer-state': 'active',
        'deadline-status': 'ok now=1 deadline=9999 remaining=9998',
        'app-health': 'healthy',
        'fixture-users': '200',
        'host-metrics.jsonl': json.dumps({
            'ts': now, 'mem_used_pct': 40, 'swap_used_mb': 0,
            'oom_kills': 0, 'oom_dmesg': 0, 'load1': 1, 'restarts': '', 'errors': 0,
        }) + '\n',
    }
    fields.update(overrides)
    for name, value in fields.items():
        if value is None:
            continue
        (directory / name).write_text(value, encoding='utf-8')

    # Secret material that must never end up in an archive.
    (directory / 'run.env').write_text('SECRET=x\n', encoding='utf-8')
    (directory / 'tls.key').write_text('PRIVATE KEY\n', encoding='utf-8')

    archive = directory / 'snapshot-latest.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        for entry in directory.iterdir():
            if entry.name in ('snapshot-latest.tar.gz', 'run.env', 'tls.key'):
                continue
            tar.add(entry, arcname=entry.name)
    return directory


class EvidenceContractTests(unittest.TestCase):
    """The server contract readiness must be built on."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # The run certificate is bound to a fixed DNS name, never to the
        # address, because the address is unknown before launch.
        self.cert, self.key = make_cert(self.tmp, 'DNS:' + CERT_HOST)
        self.evidence = write_evidence(self.tmp / 'evidence')

    def test_per_file_paths_are_not_served(self):
        with ServerHarness(self.evidence, self.cert, self.key) as h:
            for path in ('/bootstrap-status', '/timer-state', '/deadline-epoch',
                         '/deployed-commit', '/host-metrics.jsonl'):
                status, _ = h.get(path)
                self.assertEqual(status, 404,
                                 f'{path} must not be served; only /evidence/<name>.tar.gz')

    def test_archive_is_served(self):
        with ServerHarness(self.evidence, self.cert, self.key) as h:
            status, body = h.get('/evidence/snapshot-latest.tar.gz')
            self.assertEqual(status, 200)
            self.assertGreater(len(body), 0)

    def test_archive_excludes_secrets(self):
        with ServerHarness(self.evidence, self.cert, self.key) as h:
            _, body = h.get('/evidence/snapshot-latest.tar.gz')
            archive = self.tmp / 'fetched.tar.gz'
            archive.write_bytes(body)
            with tarfile.open(archive) as tar:
                names = {n.lstrip('./') for n in tar.getnames()}
            for forbidden in ('run.env', 'tls.key'):
                self.assertNotIn(forbidden, names)

    def test_wrong_token_is_unauthorised(self):
        with ServerHarness(self.evidence, self.cert, self.key) as h:
            status, _ = h.get('/evidence/snapshot-latest.tar.gz', token='wrong')
            self.assertEqual(status, 401)

    def test_missing_token_is_unauthorised(self):
        with ServerHarness(self.evidence, self.cert, self.key) as h:
            status, _ = h.get('/evidence/snapshot-latest.tar.gz', token=None)
            self.assertEqual(status, 401)


class ReadinessIntegrationTests(unittest.TestCase):
    """Runs the real readiness script against the real server."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # The run certificate is bound to a fixed DNS name, never to the
        # address, because the address is unknown before launch.
        self.cert, self.key = make_cert(self.tmp, 'DNS:' + CERT_HOST)

    def run_readiness(self, harness, **env_overrides):
        env = dict(os.environ)
        env.update({
            'EVIDENCE_TOKEN': TOKEN,
            'EVIDENCE_CA': str(self.cert),
            'EXPECTED_COMMIT': COMMIT,
            'CAPACITY_HOSTNAME': CERT_HOST,
        })
        env.update(APP_ENV)
        env.update(env_overrides)
        return subprocess.run(
            ['bash', str(READINESS), '127.0.0.1', str(harness.port)],
            capture_output=True, text=True, timeout=60, env=env)

    def test_healthy_guest_passes(self):
        evidence = write_evidence(self.tmp / 'evidence')
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('READINESS PASSED', proc.stdout)

    def test_absent_metrics_fail(self):
        evidence = write_evidence(self.tmp / 'ev', **{'host-metrics.jsonl': None})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('absent or empty', proc.stdout)

    def test_empty_metrics_fail(self):
        evidence = write_evidence(self.tmp / 'ev', **{'host-metrics.jsonl': ''})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)

    def test_malformed_metrics_fail(self):
        evidence = write_evidence(self.tmp / 'ev', **{'host-metrics.jsonl': '{not json\n'})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('MALFORMED', proc.stdout)

    def test_stale_metrics_fail(self):
        old = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() - 300))
        line = json.dumps({'ts': old, 'mem_used_pct': 30, 'errors': 0}) + '\n'
        evidence = write_evidence(self.tmp / 'ev', **{'host-metrics.jsonl': line})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('stale', proc.stdout)

    def test_missing_memory_field_is_not_a_healthy_zero(self):
        line = json.dumps({'ts': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                           'errors': 0}) + '\n'
        evidence = write_evidence(self.tmp / 'ev', **{'host-metrics.jsonl': line})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('NO_MEMORY', proc.stdout)

    def test_wrong_commit_fails(self):
        evidence = write_evidence(self.tmp / 'ev', **{'deployed-commit': 'b' * 40})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('!= expected', proc.stdout)

    def test_absent_commit_fails(self):
        evidence = write_evidence(self.tmp / 'ev', **{'deployed-commit': None})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)

    def test_failed_seeding_fails(self):
        evidence = write_evidence(self.tmp / 'ev', **{'fixture-users': None})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)

    def test_too_few_fixtures_fail(self):
        evidence = write_evidence(self.tmp / 'ev', **{'fixture-users': '30'})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('expected at least 200', proc.stdout)

    def test_degraded_bootstrap_fails(self):
        evidence = write_evidence(self.tmp / 'ev', **{'bootstrap-status': 'degraded'})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)

    def test_expired_deadline_fails(self):
        evidence = write_evidence(self.tmp / 'ev',
                                  **{'deadline-epoch': str(int(time.time()) - 60)})
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('already passed', proc.stdout)

    def test_hostname_mismatch_fails(self):
        """A certificate for the wrong identity must be rejected, not accepted
        with -k."""
        wrong_cert, wrong_key = make_cert(self.tmp / 'wrong', 'DNS:wrong-name.test')
        evidence = write_evidence(self.tmp / 'ev')
        with ServerHarness(evidence, wrong_cert, wrong_key) as h:
            proc = self.run_readiness(h)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('could not fetch', proc.stdout)

    def test_missing_ca_is_a_configuration_error(self):
        evidence = write_evidence(self.tmp / 'ev')
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h, EVIDENCE_CA='')
        self.assertNotEqual(proc.returncode, 0)

    def test_wrong_token_fails(self):
        evidence = write_evidence(self.tmp / 'ev')
        with ServerHarness(evidence, self.cert, self.key) as h:
            proc = self.run_readiness(h, EVIDENCE_TOKEN='x' * 48)
        self.assertNotEqual(proc.returncode, 0)


class SnapshotScriptTests(unittest.TestCase):
    def test_snapshot_is_produced_and_excludes_secrets(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        run_dir = tmp / 'run'
        evidence = run_dir / 'evidence'
        evidence.mkdir(parents=True)
        (evidence / 'bootstrap-status').write_text('ready', encoding='utf-8')
        (run_dir / 'run.env').write_text('SECRET=1', encoding='utf-8')
        (run_dir / 'tls.key').write_text('KEY', encoding='utf-8')

        env = dict(os.environ, RUN_DIR=str(run_dir))
        proc = subprocess.run(['bash', str(SNAPSHOT)], capture_output=True,
                              text=True, timeout=60, env=env)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

        archive = evidence / 'snapshot-latest.tar.gz'
        self.assertTrue(archive.exists(), 'correctly named alias must exist for the '
                                          'server allow-list')
        with tarfile.open(archive) as tar:
            names = {n.lstrip('./') for n in tar.getnames()}
        self.assertIn('bootstrap-status', names)
        for forbidden in ('run.env', 'tls.key'):
            self.assertNotIn(forbidden, names, 'snapshot must not include run secrets')

    def test_publisher_records_the_digest_it_built(self):
        # The guest must supply the checksum the runner will verify its download
        # against: computed here, over exactly these bytes, at publish time -
        # and carried to the runner by the status channel, not by the archive.
        import hashlib
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        evidence = tmp / 'run' / 'evidence'
        evidence.mkdir(parents=True)
        (evidence / 'bootstrap-status').write_text('ready', encoding='utf-8')
        env = dict(os.environ, RUN_DIR=str(tmp / 'run'))
        proc = subprocess.run(['bash', str(SNAPSHOT)], capture_output=True,
                              text=True, timeout=60, env=env)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        meta = evidence / '.snapshot-latest.meta'
        self.assertTrue(meta.exists(), 'publisher must record the digest it built')
        record = json.loads(meta.read_text(encoding='utf-8'))
        self.assertRegex(record['name'], r'^snapshot-\d{8}T\d{6}Z\.tar\.gz$',
                         'the timestamped name, not the mutable alias')
        self.assertRegex(record['sha256'], r'^[0-9a-f]{64}$')
        actual = hashlib.sha256((evidence / record['name']).read_bytes()).hexdigest()
        self.assertEqual(record['sha256'], actual,
                         'the recorded digest must match the published bytes')
        self.assertGreater(record['bytes'], 0)
        # The meta file itself must never travel inside any archive.
        with tarfile.open(evidence / record['name']) as tar:
            self.assertNotIn('.snapshot-latest.meta', {n.lstrip('./') for n in tar.getnames()})


class DeadlineGuardTests(unittest.TestCase):
    """The guard must terminate, not exit, and must fail closed."""

    def run_guard(self, tmp, deadline_content):
        run_dir = tmp / 'run'
        evidence = run_dir / 'evidence'
        evidence.mkdir(parents=True, exist_ok=True)
        if deadline_content is not None:
            (evidence / 'deadline-epoch').write_text(deadline_content, encoding='utf-8')
        # A fake shutdown records the call instead of halting the test machine.
        fake_bin = tmp / 'bin'
        fake_bin.mkdir(exist_ok=True)
        marker = tmp / 'shutdown-called'
        (fake_bin / 'shutdown').write_text(
            f'#!/bin/bash\necho "$@" >> {marker}\n', encoding='utf-8')
        (fake_bin / 'shutdown').chmod(0o755)

        env = dict(os.environ, RUN_DIR=str(run_dir),
                   SHUTDOWN_BIN=str(fake_bin / 'shutdown'))
        started = time.monotonic()
        proc = subprocess.run(['bash', str(CAPACITY_DIR / 'deadline-guard.sh')],
                              capture_output=True, text=True, timeout=30, env=env)
        elapsed = time.monotonic() - started
        return proc, marker, evidence, elapsed

    def test_expired_deadline_actually_calls_shutdown(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        proc, marker, _, elapsed = self.run_guard(tmp, str(int(time.time()) - 10))
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(marker.exists(), 'expired deadline must call shutdown, not just exit')
        self.assertIn('deadline reached', (tmp / 'run/evidence/deadline-status').read_text())

    def test_expired_deadline_shuts_down_immediately(self):
        # The four-hour limit is a maximum: deadline enforcement must not wait
        # for any evidence window. This is the regression that caught the
        # 90s sleep the window briefly introduced into shut_down().
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        _, marker, _, elapsed = self.run_guard(tmp, str(int(time.time()) - 10))
        self.assertTrue(marker.exists())
        self.assertLess(elapsed, 10, f'guard took {elapsed:.1f}s to shut down')

    def test_missing_deadline_fails_closed(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        proc, marker, _, _ = self.run_guard(tmp, None)
        self.assertEqual(proc.returncode, 0)
        self.assertTrue(marker.exists(), 'a missing deadline must terminate, not run forever')

    def test_malformed_deadline_fails_closed_immediately(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        _, marker, _, elapsed = self.run_guard(tmp, 'not-a-number')
        self.assertTrue(marker.exists())
        self.assertLess(elapsed, 10, f'guard took {elapsed:.1f}s to fail closed')

    def test_future_deadline_does_not_terminate(self):
        tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        proc, marker, _, _ = self.run_guard(tmp, str(int(time.time()) + 3600))
        self.assertEqual(proc.returncode, 0)
        self.assertFalse(marker.exists(), 'inside the window nothing must be terminated')


if __name__ == '__main__':
    unittest.main()
