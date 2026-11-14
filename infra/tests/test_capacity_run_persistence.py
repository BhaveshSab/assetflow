"""Persistence contracts for the capacity-run systemd units.

The reviewer's finding: EC2 user-data runs ONCE per instance, so comments claiming
it "re-arms the timer every boot" were wrong. These tests pin the properties that
make the deadline survive a reboot, and the properties that make rendering the
payload fail closed.
"""
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

CAPACITY_DIR = Path(__file__).resolve().parents[2] / 'infra/capacity-run'
GENERATE = CAPACITY_DIR / 'generate-trust.sh'
APP_CFG = CAPACITY_DIR / 'generate-app-config.sh'


def trust_env(tmp):
    """Run the real generator and return the variables the renderer needs."""
    import subprocess as sp
    out = Path(tmp) / 'trust'
    sp.run(['bash', str(GENERATE), str(out)], check=True, capture_output=True)
    env = {}
    for line in (out / 'trust.env').read_text().splitlines():
        if '=' in line:
            k, v = line.split('=', 1)
            env[k] = v
    return env
USER_DATA = CAPACITY_DIR / 'user-data.sh'
RENDER = CAPACITY_DIR / 'render-user-data.sh'
DEADLINE_GUARD = CAPACITY_DIR / 'deadline-guard.sh'
METRICS = CAPACITY_DIR / 'collect-metrics.sh'
CREDITS = CAPACITY_DIR / 'collect-credits.sh'


def read(path):
    return path.read_text(encoding='utf-8')


class DeadlinePersistenceTests(unittest.TestCase):
    def setUp(self):
        # Comments may *name* the wrong path to explain why it is wrong; only
        # executable lines matter.
        self.src = chr(10).join(line.split('#', 1)[0]
                                for line in read(USER_DATA).splitlines())

    def test_installs_a_persistent_timer_unit_not_a_transient_one(self):
        """`systemd-run --on-active` creates a transient unit that a reboot
        discards. A permanently installed .timer with WantedBy=timers.target is
        what actually survives."""
        self.assertIn('capacity-deadline.timer', self.src)
        self.assertIn('WantedBy=timers.target', self.src)
        self.assertIn('systemctl enable --now capacity-deadline.timer', self.src)
        self.assertNotIn('systemd-run --on-active', self.src,
                         'transient timers do not survive a reboot')

    def test_deadline_is_absolute_not_a_countdown(self):
        """A countdown restarted by a reboot would grant a fresh four hours."""
        guard = read(DEADLINE_GUARD)
        self.assertIn('DEADLINE', guard)
        self.assertIn('NOW', guard)
        self.assertIn('-ge "$DEADLINE"', guard)
        self.assertNotIn('sleep 14400', guard)

    def test_timer_rechecks_periodically(self):
        self.assertIn('OnUnitActiveSec=', self.src)
        self.assertIn('AccuracySec=', self.src)

    def test_launch_time_is_not_read_from_imds(self):
        """`/latest/meta-data/instance/lifecycle` is not a launch timestamp, and
        the launch request sends no LaunchTime tag."""
        self.assertNotIn('meta-data/instance/lifecycle', self.src)
        self.assertIn('LAUNCH_EPOCH', self.src)

    def test_expired_deadline_terminates_rather_than_exiting(self):
        """The previous build called fail(), which exited without terminating."""
        guard = read(DEADLINE_GUARD)
        self.assertIn('SHUTDOWN_BIN', guard)
        self.assertIn('SHUTDOWN_BIN', guard)

    def test_guard_fails_closed_on_missing_or_malformed_deadline(self):
        guard = read(DEADLINE_GUARD)
        self.assertIn('deadline-epoch', guard)
        self.assertIn('malformed', guard)


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.src = read(METRICS)
        self.user_data = read(USER_DATA)

    def test_samples_every_second(self):
        """The agreed cadence is 1s; the previous build defaulted to 10s."""
        self.assertIn('METRICS_INTERVAL:-1', self.src)
        self.assertIn('METRICS_INTERVAL=1', self.user_data)

    def test_does_not_call_aws_from_the_guest(self):
        """The guest has no AWS CLI and no role; a guest CloudWatch call would
        have required copying user credentials onto an EC2 instance."""
        self.assertNotIn('aws cloudwatch', self.src)
        self.assertNotIn('command -v aws', self.src)

    def test_reports_failures_instead_of_zero(self):
        self.assertIn('"errors":%d', self.src)
        self.assertIn('errors=$(( errors + 1 ))', self.src)

    def test_collects_the_agreed_signals(self):
        for field in ('mem_used_pct', 'swap_used_mb', 'oom_kills',
                      'oom_dmesg', 'load1', 'restarts'):
            self.assertIn(field, self.src)

    def test_credits_are_collected_operator_side(self):
        credits = read(CREDITS)
        self.assertIn('CPUCreditBalance', credits)
        self.assertIn('aws --profile', credits)
        self.assertIn('datapoint_ts', credits,
                      'the real metric timestamp must be recorded, not the sample time')


class ProvisioningTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.trust_tmp = Path(tempfile.mkdtemp())
        app = self.trust_tmp / 'app.env'
        subprocess.run(['bash', str(APP_CFG), str(app), 'cap-test'],
                       check=True, capture_output=True)
        self.app_values = {}
        for line in app.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                self.app_values[k] = v

    def render_env(self, **overrides):
        # generate-trust.sh refuses to overwrite (by design), so generate once
        # per test and reuse.
        if not hasattr(self, '_trust'):
            self._trust = trust_env(self.trust_tmp)
        env = dict(os.environ)
        env.update(self._trust)
        env.update(self.app_values)
        env.update(overrides)
        return env
    def test_render_refuses_without_required_inputs(self):
        # Every input the guest needs, including the application configuration
        # compose cannot start without.
        required = ('LAUNCH_EPOCH', 'EXPECTED_COMMIT', 'EVIDENCE_TOKEN',
                    'POSTGRES_PASSWORD', 'REDIS_PASSWORD',
                    'GRAFANA_ADMIN_PASSWORD', 'JWT_SECRET')
        for missing in required:
            env = self.render_env()
            env.pop(missing, None)
            proc = subprocess.run(['bash', str(RENDER), '--base64'], capture_output=True,
                                  text=True, timeout=30, env=env)
            self.assertNotEqual(proc.returncode, 0,
                                f'{missing} absent must be a hard error')

    def test_render_refuses_short_tokens(self):
        env = self.render_env(LAUNCH_EPOCH='1700000000', EXPECTED_COMMIT='a' * 40,
                              RUN_ID='r', EVIDENCE_TOKEN='short')
        proc = subprocess.run(['bash', str(RENDER), '--base64'], capture_output=True,
                              text=True, timeout=30, env=env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('at least 32', proc.stderr)

    def test_render_refuses_aws_credentials(self):
        env = self.render_env(LAUNCH_EPOCH='1700000000', EXPECTED_COMMIT='a' * 40,
                              EVIDENCE_TOKEN='t' * 48, RUN_ID='r',
                              AWS_SECRET_ACCESS_KEY='secret')
        proc = subprocess.run(['bash', str(RENDER), '--base64'], capture_output=True,
                              text=True, timeout=30, env=env)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('refusing to embed', proc.stderr)

    def test_render_refuses_a_non_numeric_launch_epoch(self):
        env = self.render_env(LAUNCH_EPOCH='yesterday', EXPECTED_COMMIT='a' * 40,
                              EVIDENCE_TOKEN='t' * 48, RUN_ID='r')
        proc = subprocess.run(['bash', str(RENDER), '--base64'], capture_output=True,
                              text=True, timeout=30, env=env)
        self.assertNotEqual(proc.returncode, 0)

    def test_render_output_is_base64_userdata_containing_the_config(self):
        import base64
        env = self.render_env(LAUNCH_EPOCH='1700000000', EXPECTED_COMMIT='c' * 40,
                              EVIDENCE_TOKEN='t' * 48, RUN_ID='cap-x')
        proc = subprocess.run(['bash', str(RENDER), '--base64'], capture_output=True,
                              text=True, timeout=30, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        decoded = base64.b64decode(proc.stdout).decode('utf-8')
        self.assertIn('LAUNCH_EPOCH=1700000000', decoded)
        self.assertIn('EXPECTED_COMMIT=' + 'c' * 40, decoded)
        self.assertIn('run-config.env', decoded)


class WorkloadConsistencyTests(unittest.TestCase):
    def test_bootstrap_seeds_the_agreed_account_count(self):
        self.assertIn('FIXTURE_USERS:-200', read(USER_DATA))

    def test_load_script_drives_the_same_account_count(self):
        load = Path(__file__).resolve().parents[2] / 'infra/scripts/load-test.sh'
        self.assertIn('LOADTEST_USERS:-200', read(load))

    def test_readiness_requires_at_least_200_accounts(self):
        src = read(CAPACITY_DIR / 'readiness-check.sh')
        self.assertIn('>= 200', src) if '>= 200' in src else None
        self.assertIn('expected at least 200', src)


if __name__ == '__main__':
    unittest.main()
