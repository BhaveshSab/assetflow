#!/usr/bin/env python3
"""Bootstrap status endpoint: authenticated, read-only, redacted.

Started in the prelude, before packages, builds, migrations and seeding, so a
failure anywhere after that point stays readable. On a real run the console ring
buffer filled during a 58-minute image build and the fixture failure scrolled
out before anyone could read it; this endpoint exists so that cannot happen
again.

It reports the guest's own view: which stage is running, the seed's exit status,
disk and memory, and the deadline. It never reports application readiness - that
is a different question, answered by the application on its own endpoint.

Serves only these paths, never a file, never a directory, never the run
directory (which holds generated credentials):

    /status             stage, timestamps, deadline, disk, memory
    /status/seed        seed exit status, signal, elapsed time
    /status/host        disk and memory only
    /status/failure     bounded redacted failure summary and seed log tail

TLS uses the run certificate, and a bearer token is compared in constant time.
Bodies are capped at 8 KiB and every field passes through redact().
"""

from __future__ import annotations

import argparse
import hmac
import json
import re
import shutil
import ssl
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

MAX_BODY = 8 * 1024
ENDPOINTS = ("/status", "/status/seed", "/status/host", "/status/failure")

# Secrets that must not leave the guest. Deliberately blunt: an unreadable line
# is a better outcome than a leaked connection string in a record.
_SECRETS = (
    (re.compile(r"(postgres(?:ql)?://)[^@/\s]+@"), r"\1***@"),
    (re.compile(r"(?i)\b(password|passwd|secret|token|api[_-]?key|authorization)\b\s*[=:]\s*\S+"), r"\1=***"),
    (re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._\-]+"), "Bearer ***"),
    (re.compile(r'("(?:passwordHash|password|jwtSecret|secret)"\s*:\s*")[^"]*'), r"\1***"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"), "[private key removed]"),
)


def redact(text: str) -> str:
    for pattern, repl in _SECRETS:
        text = pattern.sub(repl, text)
    return text


def read_small(path: Path, limit: int = 4096) -> str:
    try:
        with path.open("rb") as handle:
            return handle.read(limit).decode("utf-8", "replace")
    except OSError:
        return ""


def disk(run_dir: Path) -> dict:
    target = run_dir if run_dir.exists() else Path("/")
    try:
        usage = shutil.disk_usage(target)
        return {
            "total_mb": usage.total // 1048576,
            "free_mb": usage.free // 1048576,
            "used_percent": round(100 * usage.used / usage.total, 1) if usage.total else None,
        }
    except OSError:
        return {"error": "unavailable"}


def memory() -> dict:
    names = {"MemTotal": "total_mb", "MemAvailable": "available_mb", "SwapTotal": "swap_total_mb", "SwapFree": "swap_free_mb"}
    out: dict = {}
    for line in read_small(Path("/proc/meminfo"), 8192).splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].rstrip(":") in names:
            try:
                out[names[parts[0].rstrip(":")]] = int(parts[1]) // 1024
            except ValueError:
                continue
    return out


def seed(run_dir: Path) -> dict:
    ev = run_dir / "evidence"
    out: dict = {"state": "not-started"}
    code = read_small(ev / "seed-exit").strip()
    if code:
        try:
            out["exit_code"] = int(code)
            out["state"] = "finished" if int(code) == 0 else "failed"
        except ValueError:
            out["state"] = "unknown"
    for label, field in (("seed-signal", "signal"), ("seed-elapsed", "elapsed_seconds"), ("seed-started-at", "started_at"), ("fixture-users", "accounts_verified")):
        value = read_small(ev / label).strip()
        if value:
            out[field] = value
    log = read_small(ev / "seed.log", 16384)
    if log:
        # Progress, so a long seed is visibly moving rather than silently hung.
        out["accounts_seen_in_log"] = len(re.findall(r"loadtest-[a-z0-9-]+-\d+@", log))
    return out


def failure(run_dir: Path) -> dict:
    ev = run_dir / "evidence"
    out: dict = {
        "bootstrap_status": redact(read_small(ev / "bootstrap-status", 512).strip()) or "unknown",
        "stage": redact(read_small(ev / "stage-current", 256).strip()) or "unknown",
    }
    summary = read_small(ev / "failure-summary", 4096)
    if summary:
        out["summary"] = [redact(x) for x in summary.splitlines()[:40]]
    log = read_small(ev / "seed.log", 16384)
    if log:
        out["seed_log_tail"] = [redact(x) for x in log.splitlines()[-20:] if x.strip()]
    return out


def status(run_dir: Path) -> dict:
    ev = run_dir / "evidence"
    now = int(time.time())
    out: dict = {
        "phase": "bootstrap",
        "now_epoch": now,
        "stage": redact(read_small(ev / "stage-current", 256).strip()) or "unknown",
        "stage_started_at": read_small(ev / "stage-started-at", 64).strip() or None,
        "bootstrap_status": redact(read_small(ev / "bootstrap-status", 512).strip()) or "unknown",
        "disk": disk(run_dir),
        "memory": memory(),
        "application_ready": False,
        "note": "diagnostic channel; application readiness is reported by the application, not here",
    }
    deadline = read_small(ev / "deadline-epoch", 32).strip()
    if deadline.isdigit():
        remaining = int(deadline) - now
        out.update(deadline_epoch=int(deadline), deadline_remaining_seconds=remaining, deadline_state="passed" if remaining <= 0 else "active")
    else:
        # An unreadable deadline is not "fine".
        out["deadline_state"] = "unreadable"
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "assetflow-bootstrap-status"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _ok(self) -> bool:
        header = self.headers.get("Authorization", "")
        if not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].encode(), self.server.token.encode())

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        if len(body) > MAX_BODY:
            code, body = 500, json.dumps({"error": "response exceeded size cap"}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if not self._ok():
            self._json(401, {"error": "unauthorised"})
            return
        run_dir: Path = self.server.run_dir
        path = self.path.split("?", 1)[0]
        if path == "/status":
            self._json(200, status(run_dir))
        elif path == "/status/seed":
            self._json(200, seed(run_dir))
        elif path == "/status/host":
            self._json(200, {"disk": disk(run_dir), "memory": memory()})
        elif path == "/status/failure":
            self._json(200, failure(run_dir))
        else:
            self._json(404, {"error": "not found", "available": list(ENDPOINTS)})


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--cert", required=True)
    p.add_argument("--key", required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--port", type=int, default=9444)
    p.add_argument("--host", default="127.0.0.1")
    a = p.parse_args()
    if not a.token:
        print("bootstrap_status: refusing to start without a token", flush=True)
        return 2
    server = ThreadingHTTPServer((a.host, a.port), Handler)
    server.token = a.token
    server.run_dir = Path(a.run_dir)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=a.cert, keyfile=a.key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    print(f"bootstrap_status: listening on {a.host}:{a.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
