"""Tests for the post-launch configuration readback.

A good launch was thrown away by a readback bug: the instance was created exactly
as approved, but the instance-profile assertion reported 'set' for a correctly
profile-less instance. The two unusable statuses were conflated:

    .IamInstanceProfile // "null" | if . == null then ... end

`//` yields the STRING "null" when the field is absent, and a string is never
equal to JSON null, so the branch always took the "set" path. The run aborted,
the instance was terminated and the attempt was lost - not to a fault in the
launch, but to a fault in the check.

These tests pin the corrected form and, crucially, assert that the check can
report each outcome rather than only one.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra" / "capacity-run" / "verify-instance.sh"


class InstanceProfileCheckTests(unittest.TestCase):
    def setUp(self):
        self.text = SCRIPT.read_text(encoding="utf-8")

    def test_absent_and_present_are_distinguished_by_key_presence(self):
        line = next(l for l in self.text.splitlines() if "no instance profile" in l)
        self.assertIn('has("IamInstanceProfile")', line)

    def test_the_unreachable_comparison_is_gone(self):
        # The old form could never select the "null" branch.
        self.assertNotIn('IamInstanceProfile // "null"', self.text)

    def test_expected_value_is_absent(self):
        line = next(l for l in self.text.splitlines() if "no instance profile" in l)
        m = re.search(r'check "no instance profile" "([^"]+)"', line)
        self.assertIsNotNone(m, "could not read the expected value")
        self.assertEqual(m.group(1), "absent")

    def test_both_branches_exist(self):
        line = next(l for l in self.text.splitlines() if "no instance profile" in l)
        self.assertIn('"present"', line)
        self.assertIn('"absent"', line)

    def test_launch_never_requests_a_profile(self):
        # The readback asserts absence, so the launch must not ask for one.
        launch = (ROOT / "infra" / "capacity-run" / "launch-once.sh").read_text(encoding="utf-8")
        self.assertNotIn("--iam-instance-profile", launch)

    def test_failures_are_counted_not_swallowed(self):
        self.assertIn("FAILURES=$((FAILURES + 1))", self.text)
        self.assertIn("FAILURES", self.text.split("FAILURES=")[0] + "FAILURES=")

    def test_script_fails_when_any_check_fails(self):
        tail = self.text[self.text.rindex("FAILURES"):]
        self.assertIn("exit 1", tail)


class ReadbackCompletenessTests(unittest.TestCase):
    """The readback must still assert the things the API *does* report."""

    def setUp(self):
        self.text = SCRIPT.read_text(encoding="utf-8")

    def test_asserts_the_approved_configuration(self):
        for fragment in (
            'check "instance type" "t3.micro"',
            'check "cpu credits" "standard"',
            'root volume size',
            'root volume type',
            'delete-on-terminate',
            'check "RunId tag"',
            'check "Project tag"',
        ):
            self.assertIn(fragment, self.text, fragment)

    def test_uses_approval_required_flag_for_shutdown_behaviour(self):
        # describe-instances does not report this; a separate call is needed.
        self.assertIn("describe-instance-attribute", self.text)

    def test_credit_specification_uses_its_own_api(self):
        self.assertIn("describe-instance-credit-specifications", self.text)


if __name__ == "__main__":
    unittest.main()
