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
import stat
import subprocess
import tempfile
import textwrap
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
