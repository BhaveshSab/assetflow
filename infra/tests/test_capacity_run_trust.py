"""End-to-end TLS trust tests for the capacity run.

These exercise the REAL components on a real socket:
  * the real generate-trust.sh producing the operator's material,
  * the real evidence_server.py serving it,
  * the real readiness-check.sh and export-evidence.sh as subprocesses.

The point the reviewer made is that a test asserting a flag exists proves nothing.
Each assertion below observes an actual handshake outcome: succeeds with the
certified name mapped to the address, and FAILS for a wrong name, a wrong CA or a
wrong token. If those negatives passed, the positive would be meaningless.
"""
import base64
import hashlib
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CAPACITY = REPO / 'infra/capacity-run'
GEN = CAPACITY / 'generate-trust.sh'
RENDER = CAPACITY / 'render-user-data.sh'
READINESS = CAPACITY / 'readiness-check.sh'
EXPORT = REPO / 'infra/scripts/export-evidence.sh'
SERVER = REPO / 'infra/scripts/evidence_server.py'

HOSTNAME = 'capacity-run.test'


def have(tool):
    return shutil.which(tool) is not None


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def run(cmd, env=None, timeout=60):
    return subprocess.run(cmd, capture_output=True, text=True,
                          timeout=timeout, env=env)


@unittest.skipUnless(have('openssl') and have('curl'), 'openssl and curl required')
class TrustGenerationTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.out = self.dir / 'trust'

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def generate(self, env=None):
        return run(['bash', str(GEN), str(self.out)], env=env)

    def test_generates_all_material(self):
        proc = self.generate()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        for name in ('tls.crt', 'tls.key', 'evidence.token', 'trust.env'):
            self.assertTrue((self.out / name).exists(), f'{name} missing')

    def test_certificate_carries_the_dns_san(self):
        self.generate()
        proc = run(['openssl', 'x509', '-in', str(self.out / 'tls.crt'),
                    '-noout', '-ext', 'subjectAltName'])
        self.assertIn(f'DNS:{HOSTNAME}', proc.stdout)

    def test_certificate_san_is_not_the_instance_ip(self):
        """A cert bound to the public IP could not be generated before launch."""
        self.generate()
        proc = run(['openssl', 'x509', '-in', str(self.out / 'tls.crt'),
                    '-noout', '-ext', 'subjectAltName'])
        self.assertNotIn('IP Address', proc.stdout)

    def test_private_material_is_not_world_readable(self):
        self.generate()
        if os.name == 'nt':
            self.skipTest('POSIX modes are not meaningful on Windows')
        for name in ('tls.key', 'evidence.token', 'trust.env'):
            mode = (self.out / name).stat().st_mode & 0o777
            self.assertEqual(mode & 0o077, 0, f'{name} is group/world accessible')
        self.assertEqual(self.out.stat().st_mode & 0o077, 0)

    def test_token_is_long_and_random(self):
        self.generate()
        first = (self.out / 'evidence.token').read_text().strip()
        self.assertGreaterEqual(len(first), 32)
        second_dir = self.dir / 'again'
        run(['bash', str(GEN), str(second_dir)])
        second = (second_dir / 'evidence.token').read_text().strip()
        self.assertNotEqual(first, second, 'tokens must not repeat between runs')

    def test_output_never_prints_the_token_or_key(self):
        proc = self.generate()
        token = (self.out / 'evidence.token').read_text().strip()
        self.assertNotIn(token, proc.stdout + proc.stderr)

    def test_refuses_to_overwrite_existing_material(self):
        self.generate()
        proc = self.generate()
        self.assertEqual(proc.returncode, 2)
        self.assertIn('refusing to overwrite', proc.stderr)


@unittest.skipUnless(have('openssl') and have('curl'), 'openssl and curl required')
class RenderedBootstrapTests(unittest.TestCase):
    """The rendered artifact must actually install the supplied trust material."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.out = self.dir / 'trust'
        run(['bash', str(GEN), str(self.out)])

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def render(self, **overrides):
        env = dict(os.environ)
        for line in (self.out / 'trust.env').read_text().splitlines():
            if '=' in line:
                k, v = line.split('=', 1)
                env[k] = v
        env.update({'LAUNCH_EPOCH': '1700000000',
                    'EXPECTED_COMMIT': 'd' * 40, 'RUN_ID': 'cap-test'})
        env.update(overrides)
        return run(['bash', str(RENDER)], env=env)

    def test_rendered_payload_installs_the_trust_material(self):
        proc = self.render()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        script = base64.b64decode(proc.stdout).decode('utf-8')

        # The prologue must write the operator's cert and key verbatim.
        expected_crt = base64.b64encode(
            (self.out / 'tls.crt').read_bytes()).decode()
        self.assertIn(expected_crt, script)
        self.assertIn('/etc/capacity-run/tls.crt', script)
        self.assertIn('/etc/capacity-run/tls.key', script)
        self.assertIn('chmod 600 /etc/capacity-run/tls.key', script)

    def test_rendered_payload_configures_the_certified_hostname(self):
        proc = self.render()
        script = base64.b64decode(proc.stdout).decode('utf-8')
        self.assertIn(f'CAPACITY_HOSTNAME={HOSTNAME}', script)

    def test_rendered_payload_contains_no_s3_path(self):
        proc = self.render()
        script = base64.b64decode(proc.stdout).decode('utf-8').lower()
        for token in ('s3_bucket', 'aws s3', 's3://'):
            self.assertNotIn(token, script, 'S3 trust publishing must be gone')

    def test_rendered_payload_contains_no_aws_credentials(self):
        for var in ('AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
                    'AWS_ACCESS_KEY_ID'):
            proc = self.render(**{var: 'leaked-value'})
            self.assertEqual(proc.returncode, 3, f'{var} was accepted')
            self.assertIn('refusing to embed', proc.stderr)


@unittest.skipUnless(have('openssl') and have('curl'), 'openssl and curl required')
class LiveTlsTests(unittest.TestCase):
    """Real server, real certs, real client scripts, real handshakes."""

    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp())
        cls.trust = cls.dir / 'trust'
        run(['bash', str(GEN), str(cls.trust)])

        cls.evidence = cls.dir / 'evidence'
        cls.evidence.mkdir()
        (cls.evidence / 'bootstrap-status').write_text('ready')
        (cls.evidence / 'deployed-commit').write_text('e' * 40)
        deadline = int(time.time()) + 3600
        (cls.evidence / 'deadline-epoch').write_text(str(deadline))
        (cls.evidence / 'deadline-timer-state').write_text('active')
        (cls.evidence / 'deadline-status').write_text('ok 3600')
        (cls.evidence / 'app-health').write_text('healthy')
        (cls.evidence / 'fixture-users').write_text('200')
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        (cls.evidence / 'host-metrics.jsonl').write_text(
            '{"ts":"%s","mem_used_pct":22.5,"swap_used_mb":3,'
            '"oom_kills":0,"errors":0}\n' % now)

        # A snapshot as snapshot-evidence.sh would produce it, with the
        # forbidden files deliberately NOT present.
        cls.archive = cls.evidence / 'snapshot-latest.tar.gz'
        subprocess.run(['tar', '-czf', str(cls.archive), '-C', str(cls.evidence),
                        'bootstrap-status', 'deployed-commit', 'deadline-epoch',
                        'deadline-timer-state', 'deadline-status', 'app-health',
                        'fixture-users', 'host-metrics.jsonl'],
                       check=True)
        cls.digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()

        cls.port = free_port()
        env = dict(os.environ, EVIDENCE_DIR=str(cls.evidence),
                   EVIDENCE_TOKEN=(cls.trust / 'evidence.token').read_text().strip())
        cls.server = subprocess.Popen(
            [sys.executable, str(SERVER),
             '--cert', str(cls.trust / 'tls.crt'),
             '--key', str(cls.trust / 'tls.key'),
             '--port', str(cls.port), '--host', '127.0.0.1'],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        for _ in range(80):
            try:
                with socket.create_connection(('127.0.0.1', cls.port), 0.2):
                    break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError('evidence server did not start')

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        try:
            cls.server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.server.kill()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def client_env(self, **overrides):
        env = dict(os.environ,
                   EVIDENCE_TOKEN=(self.trust / 'evidence.token').read_text().strip(),
                   EVIDENCE_CA=str(self.trust / 'tls.crt'),
                   CAPACITY_HOSTNAME=HOSTNAME,
                   EXPECTED_COMMIT='e' * 40)
        env.update(overrides)
        return env

    # --- the positive case the whole design exists for -------------------
    def test_readiness_passes_with_certified_name_mapped_to_address(self):
        proc = run(['bash', str(READINESS), '127.0.0.1', str(self.port)],
                   env=self.client_env())
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn('READINESS PASSED', proc.stdout)

    def test_export_verifies_by_checksum(self):
        out = self.dir / 'exported.tar.gz'
        proc = run(['bash', str(EXPORT),
                    f'https://{HOSTNAME}:{self.port}',
                    'snapshot-latest.tar.gz', self.digest, str(out)],
                   env=self.client_env(EXPORT_RESOLVE=f'{HOSTNAME}:{self.port}:127.0.0.1'))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(hashlib.sha256(out.read_bytes()).hexdigest(), self.digest)

    # --- the negatives that give the positive meaning --------------------
    def test_wrong_hostname_fails(self):
        proc = run(['bash', str(READINESS), '127.0.0.1', str(self.port)],
                   env=self.client_env(CAPACITY_HOSTNAME='wrong-name.test'))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('READINESS FAILED', proc.stdout)

    def test_wrong_ca_fails(self):
        other = self.dir / 'other'
        run(['bash', str(GEN), str(other)])
        proc = run(['bash', str(READINESS), '127.0.0.1', str(self.port)],
                   env=self.client_env(EVIDENCE_CA=str(other / 'tls.crt')))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('READINESS FAILED', proc.stdout)

    def test_wrong_token_fails(self):
        proc = run(['bash', str(READINESS), '127.0.0.1', str(self.port)],
                   env=self.client_env(EVIDENCE_TOKEN='x' * 48))
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('READINESS FAILED', proc.stdout)

    def test_export_with_wrong_ca_fails(self):
        other = self.dir / 'other2'
        run(['bash', str(GEN), str(other)])
        out = self.dir / 'x.tar.gz'
        proc = run(['bash', str(EXPORT),
                    f'https://{HOSTNAME}:{self.port}', 'snapshot-latest.tar.gz',
                    self.digest, str(out)],
                   env=self.client_env(
                       EVIDENCE_CA=str(other / 'tls.crt'),
                       EXPORT_RESOLVE=f'{HOSTNAME}:{self.port}:127.0.0.1',
                       EXPORT_ATTEMPTS='1'))
        self.assertNotEqual(proc.returncode, 0)

    def test_export_with_wrong_checksum_fails(self):
        out = self.dir / 'bad.tar.gz'
        proc = run(['bash', str(EXPORT),
                    f'https://{HOSTNAME}:{self.port}', 'snapshot-latest.tar.gz',
                    'f' * 64, str(out)],
                   env=self.client_env(
                       EXPORT_RESOLVE=f'{HOSTNAME}:{self.port}:127.0.0.1',
                       EXPORT_ATTEMPTS='1'))
        self.assertEqual(proc.returncode, 75)

    def test_readiness_rejects_a_leaking_archive(self):
        """If the archive carried the key or run.env, readiness must say so."""
        leaky = self.dir / 'leaky'
        leaky.mkdir()
        for item in self.evidence.iterdir():
            if item.name != 'snapshot-latest.tar.gz':
                shutil.copy(item, leaky / item.name)
        (leaky / 'tls.key').write_text('PRIVATE KEY MATERIAL')
        subprocess.run(['tar', '-czf', str(leaky / 'snapshot-latest.tar.gz'),
                        '-C', str(leaky), 'bootstrap-status', 'tls.key'], check=True)
        port = free_port()
        env = dict(os.environ, EVIDENCE_DIR=str(leaky),
                   EVIDENCE_TOKEN=(self.trust / 'evidence.token').read_text().strip())
        srv = subprocess.Popen(
            [sys.executable, str(SERVER), '--cert', str(self.trust / 'tls.crt'),
             '--key', str(self.trust / 'tls.key'), '--port', str(port),
             '--host', '127.0.0.1'],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            for _ in range(80):
                try:
                    with socket.create_connection(('127.0.0.1', port), 0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            proc = run(['bash', str(READINESS), '127.0.0.1', str(port)],
                       env=self.client_env())
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn('leaked', proc.stdout)
        finally:
            srv.terminate()
            try:
                srv.wait(timeout=10)
            except subprocess.TimeoutExpired:
                srv.kill()

    def test_no_insecure_flag_anywhere_in_the_client_path(self):
        for script in (READINESS, EXPORT):
            text = script.read_text(encoding='utf-8')
            for line in text.splitlines():
                code = line.split('#', 1)[0]
                self.assertNotIn('--insecure', code)
                self.assertNotRegex(code, r'curl[^|]*\s-k\b')


if __name__ == '__main__':
    unittest.main()
