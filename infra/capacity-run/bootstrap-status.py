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
import os
import re
import shutil
import subprocess
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
    # Matches LOADTEST_PASSWORD=..., not just a bare `password=`; the previous
    # \b-anchored pattern missed every prefixed name, which is most of them.
    (re.compile(r"(?i)([\w-]*(?:password|passwd|secret|token|api[_-]?key))\s*[=:]\s*\S+"), r"\1=***"),
    # Bearer must be masked as a whole; masking only `Authorization:` left the
    # token itself in the output.
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]+"), "Bearer ***"),
    (re.compile(r"(?i)\bauthorization\s*[=:]\s*\S+"), "Authorization=***"),
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


# Seed lifecycle states. The point of the extra ones is that a seed which dies
# without writing its own exit record must still be visible: that was the case
# a previous run hit, where the instance was gone and nothing said why.
#
#   not-started  no start marker yet
#   running      start marker present, no completion record, work still alive
#   succeeded    completion record, exit 0
#   failed       completion record, non-zero exit
#   interrupted  start marker present, no completion record, and the process or
#                container is no longer running - it died without recording why
#   unknown      the evidence needed to decide is unreadable
SEED_STATES = ("not-started", "running", "succeeded", "failed", "interrupted", "unknown")


def _alive(pid_text: str) -> bool | None:
    """True/False if the pid's liveness can be decided, None if it cannot.

    None is not False: an unreadable or absent pid must not be reported as dead,
    because that would turn "I cannot tell" into "it stopped".
    """
    pid_text = pid_text.strip()
    if not pid_text or not pid_text.isdigit():
        return None
    try:
        os.kill(int(pid_text), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def _container_running(run_dir: Path) -> bool | None:
    """Whether the seed container is up, or None if that cannot be established.

    The helper writes the container id it started. We ask Docker about that exact
    container so liveness does not depend on the seed process cooperating.
    """
    cid = read_small(run_dir / "evidence" / "seed-container", 128).strip()
    if not cid or len(cid) < 8 or not re.fullmatch(r"[0-9a-fA-F]+", cid):
        return None
    try:
        proc = subprocess.run(
            ["docker", "inspect", "--format", "{{.State.Running}}", cid],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    out = proc.stdout.strip()
    if out == "true":
        return True
    if out == "false":
        return False
    # A non-zero status here means we could not ask, not that it stopped.
    return None


def seed(run_dir: Path) -> dict:
    ev = run_dir / "evidence"
    started = read_small(ev / "seed-started-at").strip()
    code = read_small(ev / "seed-exit").strip()

    out: dict = {}

    if not started and not code:
        out["state"] = "not-started"
    elif code:
        try:
            exit_code = int(code)
        except ValueError:
            # A completion record we cannot parse is not a success.
            out["state"] = "unknown"
            out["reason"] = "seed-exit is not an integer"
        else:
            out["state"] = "succeeded" if exit_code == 0 else "failed"
            out["exit_code"] = exit_code
    else:
        # Started, no completion record. Decide from liveness, never from timing:
        # a slow seed and a dead seed look identical from the clock alone.
        pid_alive = _alive(read_small(ev / "seed-pid", 32))
        container_alive = _container_running(run_dir)
        if pid_alive is False or container_alive is False:
            out["state"] = "interrupted"
            out["reason"] = (
                "the seed started and no completion record was written, and the "
                "seed is no longer running"
            )
            # Deliberately no exit code and no cause: neither is known. A
            # vanished process does not prove a timeout, and 137 alone does not
            # prove an OOM kill.
            out["exit_code"] = None
            out["cause"] = "unknown"
        elif pid_alive or container_alive:
            out["state"] = "running"
        else:
            out["state"] = "unknown"
            out["reason"] = "started, no completion record, liveness cannot be determined"

    for label, field in (
        ("seed-signal", "signal"),
        ("seed-elapsed", "elapsed_seconds"),
        ("seed-started-at", "started_at"),
        ("seed-finished-at", "finished_at"),
        ("fixture-users", "accounts_verified"),
    ):
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


def build_server(cert: str, key: str, token: str, run_dir: Path, port: int, host: str = "127.0.0.1") -> ThreadingHTTPServer:
    """Construct the TLS server. Port 0 asks the OS for a free one (tests)."""
    if not token:
        raise ValueError("refusing to start without a token")
    server = ThreadingHTTPServer((host, port), Handler)
    server.token = token
    server.run_dir = Path(run_dir)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=cert, keyfile=key)
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    return server


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--cert", required=True)
    p.add_argument("--key", required=True)
    p.add_argument("--token", required=True)
    p.add_argument("--run-dir", required=True)
    p.add_argument("--port", type=int, default=9444)
    p.add_argument("--host", default="127.0.0.1")
    a = p.parse_args()
    try:
        server = build_server(a.cert, a.key, a.token, Path(a.run_dir), a.port, a.host)
    except ValueError as exc:
        print(f"bootstrap_status: {exc}", flush=True)
        return 2
    print(f"bootstrap_status: listening on {a.host}:{a.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
