"""Behavioural tests for the operator watchdog.

The reviewer's point: a `sleep 4h` snippet is not proof a watchdog is running.
Each test here drives the real script with a fake `aws` and asserts on what it
actually did, including the cases where it must do nothing.

Bootstrap, readiness, persistence and the evidence contract are covered by
test_capacity_run_integration.py and test_capacity_run_persistence.py; the earlier
contract tests in this file asserted the superseded design (user-data re-arming a
transient timer on every boot) and have been replaced.
"""
import os
import shutil
import stat
import subprocess
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

CAPACITY_DIR = Path(__file__).resolve().parents[2] / 'infra/capacity-run'
WATCHDOG = CAPACITY_DIR / 'operator-watchdog.sh'
RUN_ID = 'cap-20261109t0800z-a7f3'


def fake_aws(directory: Path) -> Path:
    binary = directory / 'aws'
    binary.write_text(textwrap.dedent(f'''\
        #!/bin/bash
        case "$*" in
          *describe-instances*i-terminated*)
            echo '{{"State":"terminated","Launch":"2026-11-09T00:00:00+00:00","RunId":"{RUN_ID}"}}' ;;
          *describe-instances*i-wrongtag*)
            echo '{{"State":"running","Launch":"2026-11-09T00:00:00+00:00","RunId":"someone-else"}}' ;;
          *describe-instances*i-fresh*)
            echo '{{"State":"running","Launch":"'"$(date -u +%Y-%m-%dT%H:%M:%S+00:00)"'","RunId":"{RUN_ID}"}}' ;;
          *describe-instances*i-expired*)
            echo '{{"State":"running","Launch":"'"$(date -u -d '5 hours ago' +%Y-%m-%dT%H:%M:%S+00:00)"'","RunId":"{RUN_ID}"}}' ;;
          *describe-instances*)
            echo '{{}}' ;;
          *terminate-instances*)
            echo "$*" >> "$WATCHDOG_STATE_DIR/calls"
            echo '{{"TerminatingInstances":[]}}' ;;
        esac
        exit 0
    '''), encoding='utf-8')
    binary.chmod(binary.stat().st_mode | stat.S_IEXEC)
    return binary


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.state = self.tmp / 'state'
        self.state.mkdir()
        self.bin = self.tmp / 'bin'
        self.bin.mkdir()
        fake_aws(self.bin)

    def run_watchdog(self, instance_id, timeout=6):
        env = dict(os.environ)
        env.update({
            'PATH': f'{self.bin}:{env["PATH"]}',
            'WATCHDOG_STATE_DIR': str(self.state),
            'WATCHDOG_POLL': '1',
        })
        try:
            return subprocess.run(
                ['bash', str(WATCHDOG), instance_id, '14400'],
                capture_output=True, text=True, timeout=timeout, env=env)
        except subprocess.TimeoutExpired as expired:
            class Result:
                stdout = (expired.stdout or b'').decode() if expired.stdout else ''
            return Result()

    def calls(self):
        path = self.state / 'calls'
        return path.read_text(encoding='utf-8') if path.exists() else ''

    def test_expired_instance_is_terminated(self):
        self.run_watchdog('i-expired')
        self.assertIn('i-expired', self.calls())

    def test_already_terminated_is_not_terminated_again(self):
        self.run_watchdog('i-terminated')
        self.assertEqual(self.calls(), '')

    def test_wrong_run_id_is_never_terminated(self):
        """The ID could be reused or retagged; acting on it would hit the wrong
        instance. This guard is what makes ID-only teardown safe."""
        self.run_watchdog('i-wrongtag', timeout=4)
        self.assertEqual(self.calls(), '')

    def test_fresh_instance_is_left_alone(self):
        self.run_watchdog('i-fresh', timeout=4)
        self.assertEqual(self.calls(), '')

    def test_deadline_is_launch_based(self):
        proc = self.run_watchdog('i-expired')
        self.assertIn('deadline reached', proc.stdout)

    def test_unreadable_state_does_not_terminate(self):
        self.run_watchdog('i-unknown', timeout=4)
        self.assertEqual(self.calls(), '')

    def test_heartbeat_and_pid_are_written(self):
        self.run_watchdog('i-fresh', timeout=4)
        self.assertTrue((self.state / 'heartbeat').exists())
        self.assertTrue((self.state / 'pid').exists())


if __name__ == '__main__':
    unittest.main()


class DigestPinnedDeploymentTests(unittest.TestCase):
    """The measurement guest must pull CI's images, never compile them."""

    def setUp(self):
        self.script = (CAPACITY_DIR / "migrate-db.sh").read_text(encoding="utf-8")
        self.bootstrap = (CAPACITY_DIR / "user-data.sh").read_text(encoding="utf-8")

    def test_pinned_mode_pulls_and_never_builds(self):
        pinned = self.script.split("else", 1)[0]
        self.assertIn("docker pull", pinned)
        self.assertNotIn("$COMPOSE build", pinned)

    def test_partial_pin_is_refused(self):
        # Two digests and a missing third must not silently fall back to a build.
        self.assertIn("refusing a partial pin", self.script)

    def test_only_sha256_digests_are_accepted(self):
        # A tag would be mutable, which is how a previous run executed code from
        # a different revision than the one that had been tested.
        # The @ form is required, so a tag can never be spelled as a pin.
        self.assertIn("must be an immutable image@sha256: digest", self.script)
        self.assertIn("*@sha256:*", self.script)

    def test_resolved_digest_is_compared(self):
        self.assertIn("resolved to '$resolved', not the pinned digest", self.script)

    def test_seed_uses_the_same_pinned_image_as_the_migration(self):
        # The seed runs in the migrate image; unpinned it could run different code.
        self.assertIn('MIGRATE_IMAGE="${FIXTURE_MIGRATE_DIGEST:-assetflow-migrate:${RUN_ID}}"', self.bootstrap)

    def test_digests_are_not_carried_in_user_data(self):
        # 71 characters each against a 16 KiB cap; they live in the checkout.
        self.assertIn("image-digests.env", self.bootstrap)
        self.assertNotIn("FIXTURE_API_DIGEST=$", self.bootstrap)

    def test_published_images_have_no_latest_tag(self):
        ci = (CAPACITY_DIR.parents[1] / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        job = ci.split("capacity-images:", 1)[1]
        self.assertNotIn(":latest", job)
        self.assertIn("packages: write", job)
        # Anonymous pull must be proven before anything depends on it.
        self.assertIn("docker logout ghcr.io", job)


class ShutdownEvidenceWindowTests(unittest.TestCase):
    """Bootstrap-error shutdowns may hold a bounded evidence window so the
    off-host poller captures the failure reason; deadline enforcement may not.

    Attempts 9 and 10 died with no recoverable reason: every shutdown path
    wrote its reason and called `shutdown -h now` immediately, and the poller
    (30s sampling) lost the race. The correction gives BOOTSTRAP-ERROR paths a
    bounded window, capped by the remaining approved lifetime and skipped when
    the deadline cannot be validated. DEADLINE ENFORCEMENT (deadline-guard.sh)
    has no window at all: the four-hour limit is a maximum, not a deadline
    after which evidence collection begins.
    """

    def setUp(self):
        self.bootstrap = (CAPACITY_DIR / "user-data.sh").read_text(encoding="utf-8")
        self.guard = (CAPACITY_DIR / "deadline-guard.sh").read_text(encoding="utf-8")

    def test_window_is_bounded_and_defaults_to_ninety(self):
        self.assertIn('EW_SECONDS="${EW_SECONDS:-90}"', self.bootstrap)
        self.assertIn("''|*[!0-9]*) EW_SECONDS=90", self.bootstrap)
        self.assertIn('[ "$EW_SECONDS" -le 180 ] || EW_SECONDS=180', self.bootstrap)

    def test_deadline_guard_has_no_window_and_no_sleep(self):
        # The four-hour limit is a maximum: deadline enforcement must be
        # immediate, so the guard carries no window, no clamp and no sleep.
        self.assertNotIn("evidence_window", self.guard)
        self.assertNotIn("EW_SECONDS", self.guard)
        self.assertNotIn("sleep ", self.guard)

    def test_die_records_the_reason_then_shuts_down(self):
        body = self.bootstrap[
            self.bootstrap.index("die() {") : self.bootstrap.index("on_error() {")
        ]
        self.assertIn("failure-summary", body)
        self.assertLess(body.index("evidence_window"), body.index("shutdown -h now"))

    def test_the_window_writes_the_reason_to_status_before_sleeping(self):
        # The off-host record must carry the reason AND the countdown.
        start = self.bootstrap.index("evidence_window() {")
        end = self.bootstrap.index("\n}\n", start)
        body = self.bootstrap[start:end]
        self.assertIn('status "failed: $1', body)
        self.assertLess(body.index('status "failed: $1'), body.index("sleep"))

    def test_on_error_also_records_the_failure_summary(self):
        # Only die() used to write the marker; an unguarded failure must explain
        # itself just as completely.
        body = self.bootstrap[
            self.bootstrap.index("on_error() {") : self.bootstrap.index("trap 'on_error")
        ]
        self.assertIn("failure-summary", body)
        self.assertLess(body.index("failure-summary"), body.index("evidence_window"))
        self.assertLess(body.index("evidence_window"), body.index("shutdown -h now"))

    def test_the_window_reports_itself_in_the_status_body(self):
        # The captured off-host record must show the countdown, not just the
        # reason, so a retained snapshot proves the window was open.
        self.assertIn(
            "note=\"evidence-window=${wait}s pending\"", self.bootstrap
        )

    def test_a_failed_sleep_must_not_skip_the_shutdown(self):
        self.assertIn('sleep "$wait" || true', self.bootstrap)

    # -- executable checks of the real rendered function text ----------------

    def _run_window(self, deadline_epoch):
        """Extract the real clamp + evidence_window text from user-data.sh and
        run it with stubbed console_log/status/sleep, recording what it does."""
        start = self.bootstrap.index('EW_SECONDS="${EW_SECONDS:-90}"')
        chunk = self.bootstrap[start : self.bootstrap.index("\ndie() {", start)]
        cap = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, cap, True)
        epoch = "" if deadline_epoch is None else str(deadline_epoch)
        script = textwrap.dedent(f"""
            console_log() {{ echo "LOG: $1"; }}
            status() {{ printf '%s' "$1" > "$CAP/status"; }}
            sleep() {{ echo "$1" >> "$CAP/sleeps"; }}
            DEADLINE_EPOCH='{epoch}'
            CAP='{cap.as_posix()}'
            {chunk}
            evidence_window "boom rc=7"
        """)
        proc = subprocess.run(
            ["bash", "-c", script], capture_output=True, text=True, timeout=30
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        status_file = cap / "status"
        sleeps_file = cap / "sleeps"
        status = status_file.read_text(encoding="utf-8") if status_file.exists() else ""
        sleeps = sleeps_file.read_text(encoding="utf-8").split() if sleeps_file.exists() else []
        return status, sleeps

    def test_window_sleeps_the_full_default_when_lifetime_is_long(self):
        deadline = int(time.time()) + 3600
        status, sleeps = self._run_window(deadline)
        self.assertEqual(sleeps, ["90"])
        self.assertIn("evidence-window=90s pending", status)
        self.assertIn("boom rc=7", status)

    def test_window_is_capped_by_the_remaining_lifetime(self):
        # remaining - 120s margin = 80s: the window must shrink, not overrun.
        deadline = int(time.time()) + 200
        status, sleeps = self._run_window(deadline)
        self.assertEqual(sleeps, ["80"])
        self.assertIn("evidence-window=80s pending", status)

    def test_window_is_skipped_when_the_lifetime_is_nearly_spent(self):
        deadline = int(time.time()) + 100
        status, sleeps = self._run_window(deadline)
        self.assertEqual(sleeps, [])
        self.assertIn("evidence-window=0s immediate", status)
        self.assertIn("boom rc=7", status)

    def test_window_is_skipped_when_the_deadline_is_missing(self):
        # die() can fire before the config is sourced: no validated deadline,
        # no delay.
        status, sleeps = self._run_window(None)
        self.assertEqual(sleeps, [])
        self.assertIn("evidence-window=0s immediate", status)

    def test_window_is_skipped_when_the_deadline_is_not_a_number(self):
        status, sleeps = self._run_window("not-a-number")
        self.assertEqual(sleeps, [])
        self.assertIn("evidence-window=0s immediate", status)
