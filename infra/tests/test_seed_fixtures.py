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

    def test_bootstrap_declares_each_stage_once(self):
        """A duplicated stage_begin hides which stage actually ran."""
        text = BOOTSTRAP.read_text(encoding="utf-8")
        for stage in ("fixtures", "deploy", "code", "packages"):
            self.assertEqual(
                text.count(f'stage_begin "{stage}"'), 1,
                f'stage "{stage}" must begin exactly once')

    def test_ci_calls_the_shared_helper(self):
        text = CI.read_text(encoding="utf-8")
        self.assertIn("seed-fixtures.sh", text)

    def test_the_gate_builds_before_using_the_images(self):
        """The actual defect: without a build, compose pulls a prebuilt image
        and the migration never runs."""
        text = MIGRATE.read_text(encoding="utf-8")
        self.assertIn("build api migrate", text)

    def test_the_gate_pins_run_local_image_tags(self):
        """A run-local tag cannot be pulled, so the build is mandatory."""
        text = MIGRATE.read_text(encoding="utf-8")
        for var in ("MIGRATE_IMAGE", "API_IMAGE", "WEB_IMAGE"):
            self.assertIn(f'{var}="assetflow-', text)

    def test_the_gate_records_the_built_image_ids(self):
        self.assertIn("compose images", MIGRATE.read_text(encoding="utf-8").replace("$COMPOSE images", "compose images"))

    def test_bootstrap_requires_migration_completion(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        self.assertIn("migrate.log", text)
        self.assertIn("die \"database migration did not complete", text)


if __name__ == "__main__":
    unittest.main()


MIGRATE = CAPACITY / "migrate-db.sh"


class MigrationGate(unittest.TestCase):
    """`up -d migrate` is a start, not a completion.

    The bootstrap used it and then checked the log for a phrase, falling through
    to say() when nothing matched - so it could not fail. Seeding could begin
    while migrations were still running, or after one had failed.
    """

    def test_gate_is_executable(self):
        self.assertTrue(MIGRATE.stat().st_mode & stat.S_IXUSR)

    def test_gate_parses(self):
        subprocess.run(["bash", "-n", str(MIGRATE)], check=True)

    def test_gate_requires_an_evidence_dir(self):
        rc, out = _run_gate([])
        self.assertEqual(rc, 2)
        self.assertIn("--evidence-dir is required", out)

    def test_gate_rejects_a_non_numeric_timeout(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc, out = _run_gate(["--evidence-dir", tmp, "--timeout", "soon"])
            self.assertEqual(rc, 2)
            self.assertIn("integer", out)

    def test_gate_runs_the_migration_in_the_foreground(self):
        """`run` blocks and returns the container's status; `up -d` does not."""
        text = MIGRATE.read_text(encoding="utf-8")
        code = chr(10).join(l for l in text.splitlines() if not l.lstrip().startswith(chr(35)))
        self.assertIn("$COMPOSE run --rm --no-deps migrate", code)
        # `up -d postgres redis` is fine; starting the migration detached is not.
        self.assertNotIn("up -d migrate", code)

    def test_gate_propagates_a_failing_migration(self):
        with tempfile.TemporaryDirectory() as tmp:
            _make_compose_stub(tmp, migrate_rc=9)
            rc, out = _run_gate(["--evidence-dir", tmp], extra_path=tmp)
            self.assertEqual(rc, 1, out)
            self.assertIn("migration failed with exit 9", out)

    def test_gate_reports_a_timeout_rather_than_hanging(self):
        with tempfile.TemporaryDirectory() as tmp:
            _make_compose_stub(tmp, migrate_rc=124)
            rc, out = _run_gate(["--evidence-dir", tmp], extra_path=tmp)
            self.assertEqual(rc, 1, out)
            self.assertIn("timed out", out)

    def test_gate_verifies_schema_state_not_a_log_phrase(self):
        """A phrase can be missing for reasons unrelated to the schema."""
        text = MIGRATE.read_text(encoding="utf-8")
        self.assertIn("prisma migrate status", text)
        self.assertIn("information_schema.tables", text)

    def test_gate_fails_when_the_schema_is_behind(self):
        with tempfile.TemporaryDirectory() as tmp:
            _make_compose_stub(tmp, status_text="Following migration have not yet been applied")
            rc, out = _run_gate(["--evidence-dir", tmp], extra_path=tmp)
            self.assertEqual(rc, 1, out)
            self.assertIn("still has unapplied migrations", out)

    def test_gate_fails_when_the_user_table_is_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            _make_compose_stub(tmp, table_count="0")
            rc, out = _run_gate(["--evidence-dir", tmp], extra_path=tmp)
            self.assertEqual(rc, 1, out)
            self.assertIn("does not exist", out)

    def test_gate_passes_a_correct_database(self):
        with tempfile.TemporaryDirectory() as tmp:
            _make_compose_stub(tmp)
            rc, out = _run_gate(["--evidence-dir", tmp], extra_path=tmp)
            self.assertEqual(rc, 0, out)

    def test_gate_records_the_actual_image_ids(self):
        with tempfile.TemporaryDirectory() as tmp:
            _make_compose_stub(tmp)
            _run_gate(["--evidence-dir", tmp], extra_path=tmp)
            self.assertTrue((Path(tmp) / "images.txt").exists())


def _run_gate(args, extra_path=None):
    env = dict(os.environ)
    if extra_path:
        env["PATH"] = f"{extra_path}{os.pathsep}{env.get('PATH','')}"
    proc = subprocess.run(
        ["bash", str(MIGRATE), *args],
        capture_output=True, text=True, env=env, cwd=REPO_ROOT, timeout=120,
    )
    return proc.returncode, proc.stdout + proc.stderr


def _make_compose_stub(directory, *, migrate_rc=0, status_text="Database schema is up to date!",
                       table_count="1"):
    """A fake `docker compose` covering the calls the gate makes."""
    script = textwrap.dedent(
        f"""\
        #!/usr/bin/env bash
        set -uo pipefail
        case "$*" in
          *"build"*) echo "built"; exit 0 ;;
          *"migrate status"*) echo "{status_text}"; exit 0 ;;
          *"information_schema.tables"*) echo "{table_count}"; exit 0 ;;
          *"migrate"*) echo "migration output"; exit {migrate_rc} ;;
          *"images"*) echo "assetflow-migrate  run-pinned  abc123"; exit 0 ;;
          *) exit 0 ;;
        esac
        """
    )
    path = Path(directory) / "docker"
    path.write_text(script, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class BootstrapUsesTheGate(unittest.TestCase):
    def test_bootstrap_calls_the_shared_migration_gate(self):
        self.assertIn("migrate-db.sh", BOOTSTRAP.read_text(encoding="utf-8"))

    def test_bootstrap_no_longer_starts_migrate_detached(self):
        text = BOOTSTRAP.read_text(encoding="utf-8")
        code = chr(10).join(l for l in text.splitlines() if not l.lstrip().startswith(chr(35)))
        self.assertNotIn("up -d migrate", code)

    def test_ci_calls_the_same_gate(self):
        self.assertIn("migrate-db.sh", CI.read_text(encoding="utf-8"))
