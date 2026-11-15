"""Tests for export-evidence.sh: bounded retries, checksum, no TLS bypass.

The script is the gate that decides whether teardown may proceed, so its failure
behaviour is tested against a real HTTPS server rather than mocked.
"""
import hashlib
import http.server
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
SCRIPT = ROOT / 'infra/scripts/export-evidence.sh'

sys.path.insert(0, str(ROOT / 'infra/tests'))
from test_evidence_server import make_certificate, free_port  # noqa: E402

PAYLOAD = b'\x1f\x8b' + b'evidence' * 100
TOKEN = 'tok-' + 'x' * 40


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp())
        cls.cert, cls.key = make_certificate(cls.tmp)

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):  # noqa: N802
                if self.headers.get('Authorization') != f'Bearer {TOKEN}':
                    self.send_error(401)
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/gzip')
                self.send_header('Content-Length', str(len(PAYLOAD)))
                self.end_headers()
                self.wfile.write(PAYLOAD)

        cls.port = free_port()
        cls.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', cls.port), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certfile=str(cls.cert), keyfile=str(cls.key))
        cls.httpd.socket = context.wrap_socket(cls.httpd.socket, server_side=True)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'https://127.0.0.1:{cls.port}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def run_script(self, base, expected, out, env_extra=None, args=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith('EVIDENCE_')}
        env.update({
            'EVIDENCE_TOKEN': TOKEN,
            'EVIDENCE_CA': str(self.cert),
            'EXPORT_ATTEMPTS': '2',
            'EXPORT_TIMEOUT': '10',
        })
        env.update(env_extra or {})
        cmd = ['bash', str(SCRIPT)] + (args or [base, 'run.tar.gz', expected, str(out)])
        return subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=120)

    def test_a_matching_checksum_succeeds(self):
        out = self.tmp / 'ok.tar.gz'
        result = self.run_script(self.base, sha(PAYLOAD), out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(out.read_bytes(), PAYLOAD)

    # ---------------------------------------------- verified-export regression
    def test_a_blank_expected_digest_is_refused(self):
        # Regression: '' must never be treated as "nothing to check".
        out = self.tmp / 'blank.tar.gz'
        result = self.run_script(self.base, '', out)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertFalse(out.exists())

    def test_a_malformed_digest_is_refused(self):
        # Regression: a truncated/short digest is not a verifier.
        for bad in ('abc123', '0' * 63, 'z' * 64):
            with self.subTest(digest=bad):
                out = self.tmp / f'bad-{len(bad)}.tar.gz'
                result = self.run_script(self.base, bad, out)
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(out.exists())

    def test_a_failed_move_does_not_report_success(self):
        # Regression: checksum matching but an unwritable destination must not
        # exit 0. Put the output under a read-only directory.
        ro = self.tmp / 'readonly'
        ro.mkdir(exist_ok=True)
        out = ro / 'archive.tar.gz'
        ro.chmod(0o500)
        self.addCleanup(ro.chmod, 0o700)
        result = self.run_script(self.base, sha(PAYLOAD), out)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertFalse(out.exists())

    def test_unverified_mode_is_distinct_from_success(self):
        # Regression: '-' must be visibly different from a verified export and
        # must not exit 0, so a missing digest cannot look like verification.
        out = self.tmp / 'unverified.tar.gz'
        result = self.run_script(self.base, '-', out)
        self.assertEqual(result.returncode, 76, result.stderr)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('UNVERIFIED', result.stderr)
        self.assertIn('marked incomplete', result.stderr)
        self.assertEqual(out.read_bytes(), PAYLOAD, 'the bytes are still delivered')

    def test_verified_success_is_labelled_verified(self):
        out = self.tmp / 'labelled.tar.gz'
        result = self.run_script(self.base, sha(PAYLOAD), out)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('verified', result.stdout + result.stderr)
        self.assertNotIn('UNVERIFIED', result.stdout + result.stderr)

    def test_a_wrong_checksum_fails_with_75(self):
        # 75 is the caller's signal to clean up and mark the run incomplete.
        out = self.tmp / 'bad.tar.gz'
        result = self.run_script(self.base, sha(b'different'), out)
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertFalse(out.exists(), 'a bad archive must not be left in place')
        self.assertIn('checksum mismatch', result.stderr)

    def test_a_wrong_token_fails_with_75(self):
        out = self.tmp / 'unauth.tar.gz'
        result = self.run_script(self.base, sha(PAYLOAD), out,
                                 env_extra={'EVIDENCE_TOKEN': 'wrong-token'})
        self.assertEqual(result.returncode, 75, result.stderr)

    def test_plain_http_is_refused(self):
        result = self.run_script(f'http://127.0.0.1:{self.port}', sha(PAYLOAD),
                                 self.tmp / 'plain.tar.gz')
        self.assertEqual(result.returncode, 2)
        self.assertIn('non-HTTPS', result.stderr)

    def test_an_untrusted_certificate_fails_without_insecure_fallback(self):
        other_dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, other_dir, True)
        other_cert, _ = make_certificate(other_dir)
        result = self.run_script(self.base, sha(PAYLOAD), self.tmp / 'badca.tar.gz',
                                 env_extra={'EVIDENCE_CA': str(other_cert)})
        self.assertEqual(result.returncode, 75, result.stderr)

    def test_a_missing_ca_is_refused_before_any_request(self):
        result = self.run_script(self.base, sha(PAYLOAD), self.tmp / 'noca.tar.gz',
                                 env_extra={'EVIDENCE_CA': '/nonexistent/ca.pem'})
        self.assertEqual(result.returncode, 2)
        self.assertIn('does not exist', result.stderr)

    def test_retries_are_bounded(self):
        # Point at a closed port: every attempt fails, and the script must give
        # up rather than wait forever.
        closed = free_port()
        result = self.run_script(f'https://127.0.0.1:{closed}', sha(PAYLOAD),
                                 self.tmp / 'closed.tar.gz',
                                 env_extra={'EXPORT_ATTEMPTS': '2'})
        self.assertEqual(result.returncode, 75, result.stderr)
        self.assertIn('after 2 attempts', result.stderr)
        self.assertIn('mark the run incomplete', result.stderr)

    def test_no_insecure_flag_is_ever_used(self):
        # A static check on the curl invocation only: the word may legitimately
        # appear in a comment explaining that no such flag exists. The call spans
        # continuation lines, so gather the whole statement.
        text = SCRIPT.read_text(encoding='utf-8')
        joined = text.replace('\\\n', ' ')
        curl_statements = [chunk for chunk in joined.splitlines()
                           if 'curl --fail' in chunk or 'curl -' in chunk]
        self.assertTrue(curl_statements, 'expected a curl invocation')
        for statement in curl_statements:
            for forbidden in ('--insecure', ' -k', '--no-verify'):
                self.assertNotIn(forbidden, statement, f'{forbidden!r} in: {statement.strip()}')
            self.assertIn('--cacert', statement,
                          'the exporter must verify against a pinned certificate')


if __name__ == '__main__':
    unittest.main()
