"""Tests for the capacity approval gate.

The gate is a repository variable naming one exact commit. These tests exercise
the decision function itself with every input combination that must SKIP, because
a gate that silently opens on the wrong event is worse than no gate: it would
launch an instance on an ordinary push.
"""

import os
import pathlib
import re
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "capacity-run.yml"


def gate_script():
    """Extract the gate step's shell from the workflow.

    The test runs the real script rather than a copy of its logic, so a change to
    the gate is a change the tests see.
    """
    text = WORKFLOW.read_text(encoding="utf-8")
    marker = "      - name: Decide whether this run is approved"
    start = text.index(marker)
    body = text[start:]
    run_at = body.index("        run: |")
    lines = body[run_at:].splitlines()[1:]
    script = []
    for line in lines:
        if line.strip() and not line.startswith("          "):
            break
        script.append(line)
    # Drop the trailing blank lines that belong to YAML, not the script.
    while script and not script[-1].strip():
        script.pop()
    return "\n".join(script)


class GateDecisionTests(unittest.TestCase):
    GOOD_SHA = "a" * 40

    def decide(self, **env):
        base = {
            "EVENT_NAME": "push",
            "REF_NAME": "arena/595baf83-assetflow",
            "HEAD_SHA": self.GOOD_SHA,
            "APPROVED_SHA": self.GOOD_SHA,
            "RUN_ATTEMPT": "1",
            "EXPECTED_BRANCH": "arena/595baf83-assetflow",
            "GITHUB_OUTPUT": os.devnull,
            "GITHUB_STEP_SUMMARY": os.devnull,
        }
        base.update(env)
        full = dict(os.environ)
        full.update(base)
        r = subprocess.run(
            ["bash", "-c", gate_script()],
            capture_output=True, text=True, timeout=60, env=full,
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout

    def assert_skips(self, out, reason_fragment):
        self.assertIn("gate: false", out)
        self.assertIn(reason_fragment, out)

    def test_approved_push_runs(self):
        out = self.decide()
        self.assertIn("gate: true", out)
        self.assertIn("approved:", out)

    def test_unset_variable_skips(self):
        # An absent approval must fail closed: this is the default state.
        out = self.decide(APPROVED_SHA="")
        self.assert_skips(out, "is unset")

    def test_wrong_sha_skips(self):
        out = self.decide(APPROVED_SHA="b" * 40)
        self.assert_skips(out, "does not equal this commit")

    def test_prefix_of_the_sha_skips(self):
        # A short value must not match by prefix, or a short form could approve
        # something unintended. It is caught by the equality check first, which
        # is fine: the value is rejected either way.
        out = self.decide(APPROVED_SHA=self.GOOD_SHA[:12])
        self.assertIn("gate: false", out)

    def test_other_branch_skips(self):
        out = self.decide(REF_NAME="main")
        self.assert_skips(out, "not 'arena/595baf83-assetflow'")

    def test_rerun_skips(self):
        # A re-run must not create a second instance.
        out = self.decide(RUN_ATTEMPT="2")
        self.assert_skips(out, "run attempt is 2")

    def test_pull_request_skips(self):
        out = self.decide(EVENT_NAME="pull_request")
        self.assert_skips(out, "event is pull_request")

    def test_non_hex_approved_value_skips(self):
        out = self.decide(APPROVED_SHA="z" * 40, HEAD_SHA="z" * 40)
        self.assert_skips(out, "not a hex sha")

    def test_approved_with_extra_characters_skips(self):
        out = self.decide(APPROVED_SHA=self.GOOD_SHA + " ")
        self.assert_skips(out, "does not equal this commit")


class GateStructureTests(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_trigger_is_restricted_to_the_one_branch(self):
        on_block = self.text.split("on:", 1)[1].split("concurrency:", 1)[0]
        self.assertIn("arena/595baf83-assetflow", on_block)
        # No wildcard, no other branch, no schedule.
        self.assertNotIn("branches: [main]", on_block)
        self.assertNotIn("'*'", on_block)
        self.assertNotIn("schedule:", on_block)

    def test_launch_job_is_gated_on_the_gate_job(self):
        self.assertIn("needs: [gate]", self.text)
        self.assertIn("if: needs.gate.outputs.approved == 'true'", self.text)

    def test_gate_job_touches_no_aws(self):
        gate = self.text.split("gate:", 1)[1].split("  run:", 1)[0]
        self.assertNotIn("aws", gate.lower().replace("always", ""))
        self.assertNotIn("secrets.", gate)

    def test_gate_outputs_are_declared(self):
        self.assertIn("outputs:", self.text)
        self.assertIn("approved: ${{ steps.check.outputs.approved }}", self.text)

    def test_event_values_pass_through_env_not_interpolation(self):
        # github.ref_name / github.sha / vars.* must never appear inside a shell
        # command string; they are only assigned to env keys.
        for token in ("github.ref_name", "github.sha", "vars.CAPACITY_APPROVED_SHA"):
            for line in self.text.splitlines():
                if token not in line:
                    continue
                stripped = line.strip()
                is_env_assignment = re.match(r"^[A-Z_]+: \$\{\{.*\}\}$", stripped)
                self.assertTrue(
                    is_env_assignment,
                    f"{token} interpolated outside an env assignment: {stripped}",
                )

    def test_gate_is_reverified_inside_the_launch_job(self):
        self.assertIn("Re-verify the gate inside the job that spends money", self.text)

    def test_retention_only_on_success(self):
        # A successful run must not be torn down merely because it succeeded.
        self.assertIn("retain-instance", self.text)
        self.assertIn("NOT terminating", self.text)

    def test_failure_still_terminates_and_cleans_ingress(self):
        self.assertIn("did not reach readiness; terminating", self.text)
        self.assertIn("ingress.sh close", self.text)

    def test_no_load_test(self):
        self.assertNotIn("k6", self.text)
        self.assertNotIn("load-test.sh", self.text)


class StageBoundaryTests(unittest.TestCase):
    """Stage 3 must end without load testing, and Stage 4 must be possible later."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_observation_is_bounded_by_the_deadline(self):
        self.assertIn("--max-minutes 230", self.text)
        self.assertIn("timeout-minutes: 240", self.text)

    def test_runner_trust_is_retained_for_a_later_stage(self):
        # The same runner keeps its CA and token, which is what lets a Stage 4
        # test authenticate without re-provisioning.
        self.assertIn("--trust-dir \"$RUNNER_TEMP/trust\"", self.text)

    def test_supervision_only_ever_dry_runs_termination(self):
        # The supervisor must never terminate: it observes. The only terminate
        # call it makes is a P3 dry-run, which is checked explicitly so a future
        # edit cannot quietly turn it into a real termination.
        sup = (ROOT / "infra" / "capacity-run" / "supervise-run.sh").read_text(encoding="utf-8")
        for line in sup.splitlines():
            if "terminate-instances" in line and not line.strip().startswith("if "):
                self.assertIsNone(
                    re.search(r"terminate-instances", line),
                    f"unconditional terminate in supervise-run.sh: {line.strip()}")
        calls = [l for l in sup.splitlines() if "terminate-instances" in l]
        self.assertEqual(len(calls), 1, f"expected exactly one terminate call, got {calls}")
        self.assertIn("--dry-run", calls[0])

    def test_workflow_declares_stage4_boundary_in_a_comment(self):
        self.assertIn("Stage 4", self.text)


if __name__ == "__main__":
    unittest.main()
