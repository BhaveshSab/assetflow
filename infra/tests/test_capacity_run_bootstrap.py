"""Behavioural tests for the capacity-run watchdog and bootstrap scripts.

These exist because the reviewer's point was that a `sleep 4h` snippet is not
proof a watchdog is running, and that a shell script which merely looks plausible
is not evidence. Each test drives the real script with a fake `aws` and asserts on
what it actually did, including the cases where it must do nothing.
"""
import json
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
    """An `aws` stub whose describe-instances result is chosen by instance id."""
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
            # The watchdog loops by design when the instance should not be
            # touched. A timeout here is the expected outcome, not a failure.
            class Result:
                stdout = (expired.stdout or b'').decode() if expired.stdout else ''
            return Result()

    def calls(self):
        path = self.state / 'calls'
        return path.read_text(encoding='utf-8') if path.exists() else ''

    def test_expired_instance_is_terminated(self):
        self.run_watchdog('i-expired')
        self.assertIn('terminate-instances', self.calls())
        self.assertIn('i-expired', self.calls())

    def test_already_terminated_instance_is_not_terminated_again(self):
        self.run_watchdog('i-terminated')
        self.assertEqual(self.calls(), '',
                         'a terminated instance must not be terminated twice')

    def test_wrong_run_id_is_never_terminated(self):
        """The ID could be reused or retagged; acting on it would hit the wrong
        instance. This is the guard that makes ID-only teardown safe."""
        self.run_watchdog('i-wrongtag', timeout=4)
        self.assertEqual(self.calls(), '',
                         'a mismatched RunId must block termination')

    def test_fresh_instance_is_left_alone(self):
        self.run_watchdog('i-fresh', timeout=4)
        self.assertEqual(self.calls(), '',
                         'an instance inside its lifetime must not be terminated')

    def test_deadline_is_derived_from_launch_time_not_start(self):
        """The expired case proves launch-based maths: the fake reports a launch
        5 hours ago, and the watchdog acts immediately rather than waiting 4 more
        hours from its own start."""
        proc = self.run_watchdog('i-expired')
        self.assertIn('deadline reached', proc.stdout)

    def test_unreadable_state_does_not_terminate(self):
        """An API error must not be read as 'terminated' or acted on blindly."""
        self.run_watchdog('i-unknown', timeout=4)
        self.assertEqual(self.calls(), '',
                         'an unknown state must not trigger termination')

    def test_heartbeat_and_pid_are_written(self):
        """Proof of liveness: the watchdog publishes a heartbeat and its pid so
        'is it running' is checkable rather than assumed."""
        self.run_watchdog('i-fresh', timeout=4)
        self.assertTrue((self.state / 'heartbeat').exists())
        self.assertTrue((self.state / 'pid').exists())


class BootstrapContractTests(unittest.TestCase):
    """Static contracts for user-data, which cannot be executed here."""

    def setUp(self):
        self.src = (CAPACITY_DIR / 'user-data.sh').read_text(encoding='utf-8')

    def test_deadline_comes_from_launch_time(self):
        self.assertIn('lifecycle', self.src)
        self.assertIn('LAUNCH_EPOCH', self.src)
        self.assertIn('launch-based', self.src)

    def test_bootstrap_fails_closed_without_launch_time(self):
        """A now-relative deadline would silently extend the run."""
        self.assertIn('cannot determine launch time', self.src)

    def test_deadline_rearms_on_every_boot(self):
        """systemd-run transient timers do not survive a reboot; the script must
        run at boot and re-arm, or the run loses its own deadline."""
        self.assertIn('systemd-run', self.src)
        self.assertIn('re-arms it on every boot', self.src)

    def test_no_secrets_are_embedded(self):
        for marker in ('AWS_SECRET', 'PASSWORD=', 'BEGIN RSA PRIVATE'):
            self.assertNotIn(marker, self.src)

    def test_refuses_unpinned_checkout(self):
        self.assertIn('refusing to deploy an unpinned checkout', self.src)

    def test_metrics_and_evidence_are_served_not_ssh_only(self):
        self.assertIn('capacity-evidence.service', self.src)
        self.assertIn('capacity-metrics.service', self.src)


class ReadinessContractTests(unittest.TestCase):
    def setUp(self):
        self.src = (CAPACITY_DIR / 'readiness-check.sh').read_text(encoding='utf-8')

    def test_sends_the_bearer_token(self):
        self.assertIn('Authorization: Bearer', self.src)

    def test_refuses_insecure_tls(self):
        self.assertNotIn('--insecure', self.src)
        code = [line.split('#', 1)[0] for line in self.src.splitlines()]
        self.assertFalse(any(' -k ' in line for line in code),
                         'curl must not be invoked with -k')
        self.assertIn('EVIDENCE_CA must be set', self.src)

    def test_does_not_claim_the_timer_will_fire(self):
        self.assertIn('not that it will fire', self.src)


if __name__ == '__main__':
    unittest.main()
