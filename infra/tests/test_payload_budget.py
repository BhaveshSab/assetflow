"""Tests that the launcher's TLS shape keeps the payload inside its limit.

The payload has a hard 16,384-byte cap and the launcher refuses to start an
instance when it is exceeded. An approved attempt failed here: the payload
rendered to 17,991 bytes because the run-scoped TLS material was an RSA-2048
pair, whose encoded key alone is nearly 3 KB. Nothing was launched, but the
attempt was spent.

These tests pin the two properties that make the payload fit.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "capacity-run.yml"
CI = ROOT / ".github" / "workflows" / "ci.yml"
RENDERER = ROOT / "infra" / "capacity-run" / "render-user-data.sh"
DIGESTS = ROOT / "infra" / "capacity-run" / "image-digests.env"


class TlsShapeTests(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_launcher_generates_an_ecdsa_key(self):
        # RSA-2048 does not fit. This is the actual fix.
        self.assertIn("prime256v1", self.text)

    def test_launcher_never_generates_rsa(self):
        self.assertNotIn("rsa:2048", self.text)

    def test_launcher_still_sets_a_subject_alt_name(self):
        # Shrinking the key must not weaken what the certificate is valid for:
        # the client verifies the hostname over verified TLS.
        self.assertIn("subjectAltName=DNS:$CAPACITY_HOSTNAME", self.text)

    def test_launcher_keeps_the_certificate_short_lived(self):
        self.assertIn("-days 1", self.text)


class PayloadBudgetTests(unittest.TestCase):
    def test_limit_is_enforced_by_the_renderer(self):
        text = RENDERER.read_text(encoding="utf-8")
        self.assertIn("16384", text)
        self.assertIn("over the 16384 limit", text)

    def test_digests_are_not_inlined_in_the_payload(self):
        # 64-character digests belong in a committed file, read from the pinned
        # checkout, not carried in user-data where they eat the budget.
        text = RENDERER.read_text(encoding="utf-8")
        self.assertNotIn("FIXTURE_API_DIGEST", text)

    def test_digests_are_committed_for_the_bootstrap_to_source(self):
        text = DIGESTS.read_text(encoding="utf-8")
        for name in ("FIXTURE_API_DIGEST", "FIXTURE_MIGRATE_DIGEST", "FIXTURE_WEB_DIGEST"):
            self.assertRegex(text, rf'{name}="[^"]+@sha256:[0-9a-f]{{64}}"')

    def test_ci_renders_the_real_payload_before_any_launch(self):
        text = CI.read_text(encoding="utf-8")
        self.assertIn("Render the real payload with the same TLS shape", text)
        # The guard must fail the build, not warn.
        seg = text[text.index("Render the real payload with the same TLS shape"):]
        seg = seg[:seg.index("- name: Confirm the launcher")]
        self.assertIn("::error", seg)

    def test_ci_refuses_an_inlined_digest(self):
        seg = CI.read_text(encoding="utf-8")
        start = seg.index("Render the real payload with the same TLS shape")
        seg = seg[start:start + 4000]
        self.assertIn("a 64-char digest is inlined in user-data", seg)


if __name__ == "__main__":
    unittest.main()
