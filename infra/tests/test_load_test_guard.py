"""Guards that keep the saturation run off production, and keep it terminating."""
import subprocess
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'infra/scripts/load-test.sh'
PRODUCTION = 'https://13.55.90.25'


class LoadTestGuardTests(unittest.TestCase):
    def run_dry(self, base_url, **env_overrides):
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'BASE_URL': base_url}
        env.update({k: v for k, v in env_overrides.items()})
        return subprocess.run(['bash', str(SCRIPT), '--dry-run'], cwd=ROOT, env=env,
                              text=True, capture_output=True, timeout=30)

    def test_production_target_is_refused(self):
        result = self.run_dry(PRODUCTION)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('production deployment', result.stderr)
        self.assertIn(PRODUCTION, result.stderr)

    def test_production_refusal_covers_the_sslip_name(self):
        result = self.run_dry('https://13.55.90.25.sslip.io')
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('production deployment', result.stderr)

    def test_explicit_override_allows_production(self):
        result = self.run_dry(PRODUCTION, ALLOW_PRODUCTION_LOAD_TEST='yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(PRODUCTION, result.stdout)

    def test_loopback_target_runs_the_dry_run(self):
        result = self.run_dry('http://localhost:8080')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('[dry-run]', result.stdout)

    def test_password_generation_is_bounded_and_returns_40_characters(self):
        # The generator once read /dev/urandom without an upper bound, which can
        # keep producing after the consumer stops. Run the function on its own so
        # a regression shows up as a timeout, not as a hung load test.
        body = subprocess.run(
            ['sed', '-n', '/^new_loadtest_password()/,/^}/p', str(SCRIPT)],
            text=True, capture_output=True, check=True).stdout
        self.assertIn('head -c', body)
        result = subprocess.run(['bash', '-c', f'{body}\nnew_loadtest_password'],
                                text=True, capture_output=True, timeout=10)
        password = result.stdout.strip()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(password), 40, password)
        self.assertTrue(password.isalnum(), password)


if __name__ == '__main__':
    unittest.main()
