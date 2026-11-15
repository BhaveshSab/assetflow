"""Tests for the read-only evidence endpoint.

These run a real TLS server on a loopback port and speak real HTTPS to it, so
the authentication, the certificate check and the containment rules are all
exercised rather than described. Each test names the failure it prevents.
"""
import http.client
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SERVER = ROOT / 'infra/scripts/evidence_server.py'
sys.path.insert(0, str(ROOT / 'infra/scripts'))

import evidence_server  # noqa: E402

TOKEN = 'a' * 40


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def make_certificate(directory: Path) -> tuple[Path, Path]:
    """A self-signed cert for 127.0.0.1 plus its cert file (used as the pin)."""
    cert = directory / 'cert.pem'
    key = directory / 'key.pem'
    subprocess.run(
        ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
         '-keyout', str(key), '-out', str(cert), '-days', '2',
         '-subj', '/CN=127.0.0.1',
         '-addext', 'subjectAltName=IP:127.0.0.1'],
        check=True, capture_output=True,
    )
    return cert, key


class EvidenceServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.evidence = cls.tmp / 'evidence'
        cls.evidence.mkdir()
        # A real archive plus a file the regex must refuse.
        (cls.evidence / 'run-evidence.tar.gz').write_bytes(b'\x1f\x8b' + b'x' * 500)
        (cls.evidence / 'notes.txt').write_bytes(b'not an archive')
        cls.secret = cls.tmp / 'outside.tar.gz'
        cls.secret.write_bytes(b'outside the directory')

        cls.cert, cls.key = make_certificate(cls.tmp)
        cls.port = free_port()
        cls.server = evidence_server.build_server(
            cls.evidence, TOKEN, str(cls.cert), str(cls.key),
            host='127.0.0.1', port=cls.port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

        # Trust ONLY this certificate: no system store, no verification bypass.
        cls.context = ssl.create_default_context(cafile=str(cls.cert))
        cls.context.check_hostname = True
        cls.context.verify_mode = ssl.CERT_REQUIRED

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def request(self, method, path, token=TOKEN, context=None):
        conn = http.client.HTTPSConnection(
            '127.0.0.1', self.port, context=context or self.context, timeout=10)
        headers = {}
        if token is not None:
            headers['Authorization'] = f'Bearer {token}'
        conn.request(method, path, headers=headers)
        response = conn.getresponse()
        body = response.read()
        conn.close()
        return response.status, body

    # ---------------------------------------------------------- authentication
    def test_a_valid_token_gets_the_archive(self):
        status, body = self.request('GET', '/evidence/run-evidence.tar.gz')
        self.assertEqual(status, 200)
        self.assertTrue(body.startswith(b'\x1f\x8b'))
        self.assertEqual(len(body), 502)

    def test_no_token_is_refused(self):
        # The endpoint must never be anonymous: this is the whole point.
        status, _ = self.request('GET', '/evidence/run-evidence.tar.gz', token=None)
        self.assertEqual(status, 401)

    def test_a_wrong_token_is_refused(self):
        status, _ = self.request('GET', '/evidence/run-evidence.tar.gz', token='b' * 40)
        self.assertEqual(status, 401)

    def test_a_prefix_of_the_token_is_refused(self):
        # Guards against a comparison that stops early.
        status, _ = self.request('GET', '/evidence/run-evidence.tar.gz', token=TOKEN[:-1])
        self.assertEqual(status, 401)

    def test_an_empty_configured_token_never_authorises(self):
        # If the environment is misconfigured, the endpoint must fail closed
        # rather than treat "no token configured" as "no auth required".
        self.assertFalse(evidence_server.tokens_match('anything', ''))
        self.assertFalse(evidence_server.tokens_match('', ''))

    # ------------------------------------------------------------- containment
    def test_an_unexpected_filename_is_refused(self):
        status, _ = self.request('GET', '/evidence/notes.txt')
        self.assertEqual(status, 404)

    def test_traversal_is_refused(self):
        for path in (
            '/evidence/../outside.tar.gz',
            '/evidence/..%2Foutside.tar.gz',
            '/evidence/%2e%2e/outside.tar.gz',
            '/evidence//etc/passwd',
        ):
            with self.subTest(path=path):
                status, body = self.request('GET', path)
                self.assertIn(status, (400, 404), f'{path} -> {status} {body[:40]!r}')

    def test_a_missing_archive_is_refused(self):
        status, _ = self.request('GET', '/evidence/absent.tar.gz')
        self.assertEqual(status, 404)

    def test_the_root_is_not_an_index(self):
        status, _ = self.request('GET', '/')
        self.assertEqual(status, 404)

    # ---------------------------------------------------------------- read-only
    def test_write_verbs_are_refused(self):
        for method in ('POST', 'PUT', 'DELETE', 'PATCH'):
            with self.subTest(method=method):
                status, _ = self.request(method, '/evidence/run-evidence.tar.gz')
                self.assertIn(status, (401, 405))

    # ---------------------------------------------------------------------- TLS
    def test_tls_rejects_an_untrusted_certificate(self):
        # The exporter must not need --insecure: an untrusted cert fails.
        strict = ssl.create_default_context()  # system store: our cert is not in it
        strict.check_hostname = True
        with self.assertRaises(ssl.SSLError):
            self.request('GET', '/evidence/run-evidence.tar.gz', context=strict)

    def test_tls_rejects_a_wrong_hostname(self):
        # Pinning by identity, not just by trust: the cert names 127.0.0.1.
        context = ssl.create_default_context(cafile=str(self.cert))
        context.check_hostname = True
        conn = http.client.HTTPSConnection('localhost', self.port, context=context, timeout=10)
        with self.assertRaises(ssl.SSLCertVerificationError):
            conn.request('GET', '/evidence/run-evidence.tar.gz',
                         headers={'Authorization': f'Bearer {TOKEN}'})

    def test_tls_verifies_with_the_pinned_certificate(self):
        status, _ = self.request('GET', '/evidence/run-evidence.tar.gz')
        self.assertEqual(status, 200)


class EvidenceServerStartupTests(unittest.TestCase):
    """The server must refuse to start in a way that would expose the evidence."""

    def run_main(self, env_extra):
        env = {k: v for k, v in os.environ.items()
               if k not in {'EVIDENCE_DIR', 'EVIDENCE_TOKEN'}}
        env.update(env_extra)
        return subprocess.run(
            [sys.executable, str(SERVER), '--cert', '/nonexistent', '--key', '/nonexistent'],
            env=env, capture_output=True, text=True, timeout=30)

    def test_refuses_to_start_without_a_token(self):
        result = self.run_main({'EVIDENCE_DIR': tempfile.gettempdir()})
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('EVIDENCE_TOKEN', result.stderr)

    def test_refuses_a_short_token(self):
        result = self.run_main({'EVIDENCE_DIR': tempfile.gettempdir(), 'EVIDENCE_TOKEN': 'short'})
        self.assertEqual(result.returncode, 2)

    def test_refuses_a_missing_evidence_directory(self):
        result = self.run_main({'EVIDENCE_DIR': '/nonexistent/dir', 'EVIDENCE_TOKEN': 'a' * 40})
        self.assertEqual(result.returncode, 2)
        self.assertIn('EVIDENCE_DIR', result.stderr)


if __name__ == '__main__':
    unittest.main()
