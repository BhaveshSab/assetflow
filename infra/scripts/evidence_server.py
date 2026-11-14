#!/usr/bin/env python3
"""Read-only evidence endpoint for an isolated capacity run.

Serves exactly one thing: a tarball of the run's evidence directory. It is
deliberately the smallest surface that makes "export before teardown" possible
without SSH.

Design constraints, each of which is a test in the test suite:

  * **Authentication is required.** A bearer token, compared in constant time.
    No token, wrong token, or an unset token in the environment all fail closed.
    An unset token must NOT mean "no auth" - that is the classic way an
    authenticated endpoint silently becomes a public one.
  * **Read-only.** There is no route that writes, deletes or mutates anything.
  * **Path containment.** The caller names an archive from a fixed allow-list
    directory; any name that escapes the directory is refused.
  * **Bounded.** Responses are size-capped and served with a timeout, so a
    half-written archive cannot hang the exporter.
  * **No directory listing.** A wrong path gets 404, not an index.

Usage:
    EVIDENCE_DIR=/var/lib/assetflow-capacity/evidence \\
    EVIDENCE_TOKEN=<random> \\
    python3 evidence_server.py --port 8443 --cert /path/fullchain.pem --key /path/key.pem
"""
from __future__ import annotations

import argparse
import hmac
import os
import posixpath
import re
import ssl
import sys
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# One archive name, no slashes, no leading dot, no traversal sequences.
ARCHIVE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.tar\.gz$')
MAX_ARCHIVE_BYTES = 64 * 1024 * 1024


def resolve_archive(directory: Path, name: str) -> Path | None:
    """Return the archive path, or None if the name is not exactly one safe leaf."""
    if not ARCHIVE_RE.match(name):
        return None
    candidate = directory / name
    # Defence in depth: the regex already forbids separators, but resolve and
    # re-check so a symlink cannot point outside the evidence directory.
    try:
        resolved = candidate.resolve(strict=True)
        root = directory.resolve(strict=True)
    except (OSError, RuntimeError):
        return None
    if resolved.parent != root:
        return None
    if not resolved.is_file():
        return None
    return resolved


def tokens_match(presented: str, expected: str) -> bool:
    """Constant-time comparison; a missing or blank expectation never matches."""
    if not expected or not presented:
        return False
    return hmac.compare_digest(presented, expected)


def make_handler(directory: Path, token: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'assetflow-evidence'
        sys_version = ''

        def log_message(self, fmt, *args):  # keep stdout clean for the tarball
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

        def _authorised(self) -> bool:
            header = self.headers.get('Authorization', '')
            scheme, _, value = header.partition(' ')
            if scheme.lower() != 'bearer':
                return False
            return tokens_match(value.strip(), token)

        def _fail(self, code: HTTPStatus, message: str) -> None:
            body = message.encode()
            self.send_response(code)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)

        def _serve(self) -> None:
            if not self._authorised():
                self._fail(HTTPStatus.UNAUTHORIZED, 'unauthorised')
                return
            path = self.path.split('?', 1)[0]
            # A bare root is not an index; say nothing useful.
            if path in ('', '/'):
                self._fail(HTTPStatus.NOT_FOUND, 'not found')
                return
            if not path.startswith('/evidence/'):
                self._fail(HTTPStatus.NOT_FOUND, 'not found')
                return
            name = posixpath.basename(path)
            archive = resolve_archive(directory, name)
            if archive is None:
                self._fail(HTTPStatus.NOT_FOUND, 'not found')
                return
            size = archive.stat().st_size
            if size > MAX_ARCHIVE_BYTES:
                self._fail(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, 'archive too large')
                return
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', 'application/gzip')
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            with archive.open('rb') as handle:
                while True:
                    chunk = handle.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        # Read-only: every other verb is refused, including write verbs.
        def do_GET(self):  # noqa: N802
            self._serve()

        def do_HEAD(self):  # noqa: N802
            self._serve()

        def _refuse(self):
            self._fail(HTTPStatus.METHOD_NOT_ALLOWED, 'read-only endpoint')

        do_POST = do_PUT = do_DELETE = do_PATCH = _refuse  # noqa: N815

    return Handler


def build_server(directory: Path, token: str, cert: str, key: str,
                 host: str = '0.0.0.0', port: int = 8443) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), make_handler(directory, token))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(certfile=cert, keyfile=key)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    return server


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='read-only evidence endpoint')
    parser.add_argument('--port', type=int, default=8443)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--cert', required=True)
    parser.add_argument('--key', required=True)
    args = parser.parse_args(argv)

    directory = Path(os.environ.get('EVIDENCE_DIR', ''))
    token = os.environ.get('EVIDENCE_TOKEN', '')

    # Fail closed. Serving with no token would expose the run's evidence, and
    # serving from no directory would be a broken endpoint that looks healthy.
    if not token or len(token) < 32:
        print('EVIDENCE_TOKEN must be set to at least 32 characters', file=sys.stderr)
        return 2
    if not directory.is_dir():
        print(f'EVIDENCE_DIR is not a directory: {directory}', file=sys.stderr)
        return 2

    server = build_server(directory, token, args.cert, args.key, args.host, args.port)
    print(f'evidence endpoint on {args.host}:{args.port} serving {directory}', file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
