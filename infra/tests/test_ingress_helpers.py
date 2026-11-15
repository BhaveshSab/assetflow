"""Regression tests for the ingress helper.

A real launch failed here before any instance existed: the run identity is not
granted ec2:DescribeSecurityGroupRules, the listing was treated as authoritative,
and the step aborted. These tests pin the properties that failure revealed.
"""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
INGRESS = ROOT / "infra" / "capacity-run" / "ingress.sh"


class IngressPermissionTests(unittest.TestCase):
    def setUp(self):
        self.text = INGRESS.read_text(encoding="utf-8")
        # Strip comments: the text explains why these APIs are avoided.
        self.code = "\n".join(
            line for line in self.text.splitlines()
            if not line.strip().startswith("#")
        )

    def test_never_calls_the_denied_listing_api(self):
        # describe-security-group-rules is denied for this identity. A call would
        # abort a launch before the instance exists, which already happened once.
        self.assertNotIn("describe-security-group-rules", self.code)

    def test_rule_id_comes_from_authorize_not_a_second_call(self):
        # The id is read out of authorize's own response, so a missing listing
        # permission cannot prevent recording it.
        seg = self.code[self.code.index("RULE_ID="):]
        self.assertIn("SecurityGroupRuleId", seg)

    def test_no_jq_dependency_on_the_rules_path(self):
        # jq is not guaranteed on the runner; a missing jq once produced an empty
        # result that was misread as "no rule".
        self.assertNotIn("jq ", self.code)

    def test_absence_is_proven_by_a_granted_api(self):
        # describe-security-groups IS granted, so a zero is real evidence.
        self.assertIn("describe-security-groups", self.code)
        self.assertIn("count_rules_on_port", self.code)

    def test_close_fails_closed_when_absence_is_unproven(self):
        # An empty listing must not be treated as proof of cleanup.
        seg = self.code[self.code.index("REMAIN="):]
        self.assertIn("cannot verify", seg)
        self.assertIn("exit 1", seg)

    def test_open_refuses_a_non_slash_32(self):
        self.assertIn("refusing a non-/32 source", self.text)

    def test_open_refuses_a_second_rule(self):
        self.assertIn("refusing to add another", self.text)


class IngressShadowingTests(unittest.TestCase):
    """EC2_CIDRS must be defined before count_rules_on_port uses it."""

    def test_helper_defined_before_use(self):
        text = INGRESS.read_text(encoding="utf-8")
        self.assertLess(text.index("EC2_CIDRS() {"), text.index("count_rules_on_port() {"))

    def test_no_function_lookalike_variable(self):
        # A variable named like the function, or a call to itself, would recurse
        # or read an empty string.
        text = INGRESS.read_text(encoding="utf-8")
        # Skip the function's own header line before looking for a self-call.
        start = text.index("count_rules_on_port() {") + len("count_rules_on_port() {")
        body = text[start:]
        body = body[:body.index("\n}")]
        self.assertNotIn("count_rules_on_port", body)


if __name__ == "__main__":
    unittest.main()
