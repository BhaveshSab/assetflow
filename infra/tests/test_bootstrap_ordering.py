"""Prove the bootstrap ordering: the external diagnostic channel exists, and it
exists BEFORE the work that is most likely to fail.

The sixth capacity attempt died during bootstrap and the guest was not reachable
from outside at any point during that work, so the failure left no retrievable
cause. These tests pin the fix.

They run the real scripts rather than asserting against a fixture, because the
defect being guarded against is precisely an ordering mistake in the real
user-data template - a copy of it would not have caught it either.

Two halves:
  * structural - render the real payload, read the stage order out of it, and
    check the two edge configs route what they claim to route.
  * live - run the real status service over real TLS and check that auth, CA
    verification, hostname verification, redaction and off-host retention all
    behave as the operator relies on.
"""

from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
INTEGRATION = REPO / "infra" / "tests" / "integration"


def _run(script: str, timeout: int = 300) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["bash", str(INTEGRATION / script)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class BootstrapOrdering(unittest.TestCase):
    """The external diagnostic channel is published before the risky work."""

    def test_structural_ordering(self) -> None:
        result = _run("bootstrap-ordering.sh")
        self.assertEqual(
            result.returncode,
            0,
            "bootstrap ordering failed:\n%s\n%s" % (result.stdout, result.stderr),
        )
        self.assertNotIn("FAIL", result.stdout)
        # The payload must still fit the EC2 user-data limit; the proof is only
        # meaningful if the artefact it rendered is the one that can be launched.
        self.assertIn("payload fits the EC2 limit", result.stdout)

    def test_early_edge_is_diagnostics_only(self) -> None:
        early = (REPO / "infra/capacity-run/edge/edge-early.conf").read_text(encoding="utf-8")
        # The status service is TLS-only, so the upstream hop must be verified
        # TLS. A plain-HTTP proxy_pass to a TLS socket answers 502 on every
        # request - the failure the real-nginx test caught.
        self.assertIn("proxy_pass https://127.0.0.1:9444", early)
        self.assertIn("proxy_ssl_verify on", early)
        self.assertIn("proxy_ssl_trusted_certificate /etc/capacity-run/tls.crt", early)
        # The application and the evidence server do not exist yet when this
        # config runs. Routing to them would answer 502 and look like an app
        # fault, so the early edge must not route to them at all.
        self.assertNotIn("127.0.0.1:8080", early)
        self.assertNotIn("127.0.0.1:9443", early)
        self.assertIn("return 503", early)

    def test_full_edge_keeps_all_three_routes(self) -> None:
        full = (REPO / "infra/capacity-run/edge/edge.conf").read_text(encoding="utf-8")
        # The application is plain HTTP on loopback; the diagnostic services
        # are TLS-only and must be proxied over verified TLS.
        self.assertIn("proxy_pass http://127.0.0.1:8080", full)
        self.assertIn("proxy_pass https://127.0.0.1:9443", full)
        self.assertIn("proxy_pass https://127.0.0.1:9444", full)
        self.assertIn("proxy_ssl_verify on", full)
        self.assertIn("location /status", full)

    def test_one_externally_reachable_port(self) -> None:
        # Exactly one port is opened in the security group. If a config ever
        # listened on a second externally reachable port the client could not
        # reach it, and the run would look broken for a reason unrelated to the
        # application.
        for name in ("edge/edge.conf", "edge/edge-early.conf"):
            text = (REPO / "infra/capacity-run" / name).read_text(encoding="utf-8")
            for line in text.splitlines():
                stripped = line.strip()
                if stripped.startswith("listen "):
                    self.assertIn("8443", stripped, "%s listens on %s" % (name, stripped))

    def test_reachability_window_is_stated_honestly(self) -> None:
        # The renderer strips whole-line comments, so this lives in the fetched
        # body the stage runs. It must keep saying "after packages, not before":
        # docker and the nginx image come from the packages stage, so claiming
        # earlier reachability would be a lie the next reader would believe.
        body = (REPO / "infra/capacity-run/early-edge.sh").read_text(encoding="utf-8")
        self.assertIn("not pre-package observability", body)
        self.assertIn("NOT before", body)


class LiveStatusChannel(unittest.TestCase):
    """The real status service over real TLS, as the operator uses it."""

    def test_live_tls_auth_and_retention(self) -> None:
        for need in ("openssl", "curl"):
            if shutil.which(need) is None:
                self.skipTest("%s is not available in this environment" % need)
        result = _run("early-status-live.sh")
        self.assertEqual(
            result.returncode,
            0,
            "live status channel failed:\n%s\n%s" % (result.stdout, result.stderr),
        )
        self.assertNotIn("FAIL", result.stdout)
        # No cheating: the test says which mode it actually ran in, so a future
        # reader cannot mistake structural coverage for live proxy coverage.
        self.assertIn("MODE ", result.stdout)


if __name__ == "__main__":
    unittest.main()
