"""Tests for the shared fixture-seeding path.

The defect these exist for: CI and the EC2 bootstrap each held their own copy of
the seeding command. CI built the images first; the bootstrap did not, so a real
run pulled `ghcr.io/.../assetflow-migrate:latest`, applied no migrations, and
failed seeding 37 seconds later against a schema that did not match the code.
One shared script, invoked by both, is what stops that recurring.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

CAPACITY = Path(__file__).resolve().parents[1] / "capacity-run"
HELPER = CAPACITY / "seed-fixtures.sh"
BOOTSTRAP = CAPACITY / "user-data.sh"
REPO_ROOT = CAPACITY.parents[1]
CI = REPO_ROOT / ".github" / "workflows" / "ci.yml"


def _run(args, env_extra=None, cwd=None):
    """Run the helper with a stub compose on PATH, returning (rc, output)."""
    env = dict(os.environ)
    env.setdefault("PATH", "")
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        ["bash", str(HELPER), *args],
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd or REPO_ROOT,
        timeout=120,
    )
    return proc.returncode, proc.stdout + proc.stderr


def _make_stub_compose(directory: Path, *, seed_rc=0, count="200", hashes="0"):
    """A fake `docker compose` that behaves like the real one for this contract."""
    script = textwrap.dedent(
        f"""\
        #!/usr/bin/env bash
        set -uo pipefail
        case "$*" in
          *"seed:loadtest"*)
            echo "seeded some accounts"
            exit {seed_rc}
            ;;
          *"count(*)"*"passwordHash"*)
            echo "{hashes}"
            exit 0
            ;;
          *"count(*)"*)
            echo "{count}"
            exit 0
            ;;
          *)
            exit 0
            ;;
        esac
        """
    )
    path = directory / "docker"
    path.write_text(script, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    return path


class HelperContract(unittest.TestCase):
    def test_helper_is_executable(self):
        mode = HELPER.stat().st_mode
        self.assertTrue(mode & stat.S_IXUSR, "seed-fixtures.sh must be executable")

    def test_helper_parses(self):
        subprocess.run(["bash", "-n", str(HELPER)], check=True)

    def test_run_id_is_required(self):
        rc, out = _run([], env_extra={"PATH": os.environ.get("PATH", "")})
        self.assertEqual(rc, 2)
        self.assertIn("--run-id is required", out)

    def test_missing_password_is_refused_before_seeding(self):
        """One account needs no password, so a missing one would create
        accounts nobody can sign in as. Refuse instead."""
        rc, out = _run(
            ["--run-id", "cap-test-0001", "--users", "200"],
            env_extra={"LOADTEST_PASSWORD": ""},
        )
        self.assertEqual(rc, 2)
        self.assertIn("LOADTEST_PASSWORD is required", out)

    def test_non_numeric_user_count_is_refused(self):
        rc, out = _run(["--run-id", "cap-test-0001", "--users", "many"])
        self.assertEqual(rc, 2)
        self.assertIn("positive integer", out)

    def test_single_account_needs_no_password(self):
        """The seed accepts one account without a password; the helper must not
        be stricter than the thing it wraps."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _make_stub_compose(tmp_path, count="1")
            rc, out = _run(
                ["--run-id", "cap-test-0001", "--users", "1"],
                env_extra={
                    "PATH": f"{tmp_path}{os.pathsep}{os.environ.get('PATH','')}",
                    "LOADTEST_PASSWORD": "",
                },
            )
            self.assertEqual(rc, 0, out)


class FailureHandling(unittest.TestCase):
    def test_seed_failure_reports_exit_and_log_excerpt(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _make_stub_compose(tmp_path, seed_rc=1)
            rc, out = _run(
                ["--run-id", "cap-test-0001", "--users", "200"],
                env_extra={
                    "PATH": f"{tmp_path}{os.pathsep}{os.environ.get('PATH','')}",
                    "LOADTEST_PASSWORD": "generated-value",
                },
            )
            self.assertEqual(rc, 1)
            self.assertIn("seeding failed with exit 1", out)
            self.assertIn("seed output", out)

    def test_short_count_is_a_failure(self):
        """A count below the ask must fail: partial fixtures would understate
        what the run measured."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _make_stub_compose(tmp_path, count="7")
            rc, out = _run(
                ["--run-id", "cap-test-0001", "--users", "200"],
                env_extra={
                    "PATH": f"{tmp_path}{os.pathsep}{os.environ.get('PATH','')}",
                    "LOADTEST_PASSWORD": "generated-value",
                },
            )
            self.assertEqual(rc, 1)
            self.assertIn("only 7 accounts exist", out)

    def test_accounts_without_a_stored_hash_are_a_failure(self):
        """A count alone does not show every account can sign in."""
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _make_stub_compose(tmp_path, count="200", hashes="3")
            rc, out = _run(
                ["--run-id", "cap-test-0001", "--users", "200"],
                env_extra={
                    "PATH": f"{tmp_path}{os.pathsep}{os.environ.get('PATH','')}",
                    "LOADTEST_PASSWORD": "generated-value",
                },
            )
            self.assertEqual(rc, 1)
            self.assertIn("could not sign in", out)

    def test_unreadable_count_is_a_failure_not_a_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            _make_stub_compose(tmp_path, count="")
            rc, out = _run(
                ["--run-id", "cap-test-0001", "--users", "200"],
                env_extra={
                    "PATH": f"{tmp_path}{os.pathsep}{os.environ.get('PATH','')}",
                    "LOADTEST_PASSWORD": "generated-value",
                },
            )
            self.assertEqual(rc, 1)
            self.assertIn("could not count", out)


class Redaction(unittest.TestCase):
    """The summary reaches CI logs and the EC2 console, so it must be safe."""

    def _redact(self, line):
        """Run the helper's redact() over a representative line.

        The helper cannot be sourced: sourcing it runs the main body. Extract the
        function itself so the test exercises the code that actually ships.
        """
        text = HELPER.read_text(encoding="utf-8")
        start = text.index("redact() {")
        end = text.index("\n}\n", start) + 3
        body = text[start:end]
        with tempfile.TemporaryDirectory() as tmp:
            sample = Path(tmp) / "sample.txt"
            sample.write_text(line + "\n", encoding="utf-8")
            script = f"{body}\nredact {sample!s}"
            proc = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
            return proc.stdout.strip()

    def test_password_in_a_connection_string_is_masked(self):
        out = self._redact("postgresql://assetflow:hunter2@postgres:5432/assetflow")
        self.assertNotIn("hunter2", out)
        self.assertIn("***@", out)

    def test_password_assignment_is_masked(self):
        out = self._redact("LOADTEST_PASSWORD=s3cr3t-value")
        self.assertNotIn("s3cr3t-value", out)

    def test_bearer_token_is_masked(self):
        out = self._redact("Authorization: Bearer abc123def456")
        self.assertNotIn("abc123def456", out)

    def test_password_hash_is_masked(self):
        out = self._redact('{"passwordHash": "$2b$12$abcdefghijklmnop"}')
        self.assertNotIn("abcdefghijklmnop", out)


class SharedPath(unittest.TestCase):
    """CI and the bootstrap must not hold two copies of this command again."""

    def test_bootstrap_calls_the_shared_helper(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("seed-fixtures.sh", text)

    def test_bootstrap_no_longer_inlines_the_seed_command(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertNotIn("npm run seed:loadtest", text, "the bootstrap must call the helper, not duplicate it")

    def test_ci_calls_the_shared_helper(self):
        text = CI.read_text(encoding="utf-8")
        self.assertIn("seed-fixtures.sh", text)

    def test_bootstrap_builds_the_images_before_using_them(self):
        """This is the actual defect: without a build, compose pulls a prebuilt
        image and the migration never runs."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("build api migrate", text)

    def test_bootstrap_pins_run_local_image_tags(self):
        """A run-local tag cannot be pulled, so the build is mandatory."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        for var in ("MIGRATE_IMAGE", "API_IMAGE", "WEB_IMAGE"):
            self.assertIn(f'export {var}="assetflow-', text)

    def test_bootstrap_checks_the_migration_actually_ran(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("migrate.log", text)
        self.assertIn("No pending migrations", text)


if __name__ == "__main__":
    unittest.main()
