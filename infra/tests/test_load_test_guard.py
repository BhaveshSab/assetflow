"""Guards that keep the saturation run off production, and keep it terminating."""

import subprocess
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'infra/scripts/load-test.sh'
PRODUCTION = 'https://13.55.90.25'

PRODUCTION_SPELLINGS = (
    'https://13.55.90.25',
    'HTTPS://13.55.90.25',
    'https://13.55.90.25.sslip.io',
    'HTTPS://13.55.90.25.sslip.IO',
    'https://13.55.90.25.',
    'https://ec2-13-55-90-25.ap-southeast-2.compute.amazonaws.com',
    'https://ec2-13-55-90-25.us-east-1.compute.amazonaws.com',
)

DISPOSABLE = (
    'https://staging.example.com',
    'http://localhost:8080',
    'http://127.0.0.1:8080',
)


class LoadTestGuardTests(unittest.TestCase):
    def run_dry(self, base_url, **env_overrides):
        env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'BASE_URL': base_url}
        env.update(env_overrides)
        return subprocess.run(['bash', str(SCRIPT), '--dry-run'], cwd=ROOT, env=env,
                              text=True, capture_output=True, timeout=30)

    def test_production_target_is_refused(self):
        result = self.run_dry(PRODUCTION)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('production deployment', result.stderr)
        self.assertIn(PRODUCTION, result.stderr)

    def test_production_is_refused_in_any_spelling(self):
        # A plain string compare against two literals missed the uppercase form
        # and the EC2 public DNS, so a dotted spelling of production passed.
        for target in PRODUCTION_SPELLINGS:
            with self.subTest(target=target):
                result = self.run_dry(target)
                self.assertEqual(result.returncode, 1, target)
                self.assertIn('production deployment', result.stderr)

    def test_any_sslip_name_is_treated_as_production(self):
        result = self.run_dry('https://anything.sslip.io')
        self.assertEqual(result.returncode, 1)
        self.assertIn('production deployment', result.stderr)

    def test_a_disposable_stack_is_allowed(self):
        for target in DISPOSABLE:
            with self.subTest(target=target):
                result = self.run_dry(target)
                self.assertEqual(result.returncode, 0, target)
                self.assertIn('[dry-run]', result.stdout)

    def test_explicit_override_allows_production(self):
        result = self.run_dry(PRODUCTION, ALLOW_PRODUCTION_LOAD_TEST='yes')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(PRODUCTION, result.stdout)

    def test_the_guard_is_reached_before_the_banner_and_the_dry_run(self):
        # The guard once sat below the banner and below the --dry-run exit, so a
        # dry run against production printed a plan and exited 0.
        result = self.run_dry(PRODUCTION)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertNotIn('[dry-run]', result.stdout)
        self.assertNotIn('=== AssetFlow saturation test ===', result.stdout)

    def test_the_run_needs_no_preset_stages_variable(self):
        # A default concatenated onto BASE_URL made an invocation without an
        # explicit STAGES abort with "unbound variable".
        result = self.run_dry('http://localhost:8080')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('unbound variable', result.stderr)
        self.assertIn('stages:     5,10,25,50,100,200', result.stdout)

    def test_guard_refusal_is_what_blocks_not_a_syntax_error(self):
        result = self.run_dry(PRODUCTION)
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn('production deployment', result.stderr)
        self.assertNotIn('unbound variable', result.stderr)

    def test_password_generation_is_bounded_and_returns_40_characters(self):
        # The generator once read /dev/urandom without an upper bound.
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


class LoadTestPathAndCleanupTests(unittest.TestCase):
    """Docker makes the checkout visible at /work, not at its host path."""

    def setUp(self):
        self.body = (ROOT / 'infra/scripts/load-test.sh').read_text()

    def test_a_path_translator_exists_for_container_runs(self):
        self.assertIn('to_k6_path()', self.body)
        self.assertIn("/work%s", self.body)

    def test_the_summary_and_script_paths_go_through_the_translator(self):
        self.assertIn('SUMMARY_FILE="$(to_k6_path', self.body)
        self.assertIn('"$(to_k6_path "${REPO_ROOT}/infra/scripts/k6-load.js")"', self.body)

    def test_the_k6_image_is_pinned_by_version_and_digest(self):
        self.assertIn('grafana/k6:2.3.0@sha256:', self.body)

    def test_an_interrupt_trap_owns_the_sampler(self):
        self.assertIn('trap cleanup EXIT', self.body)
        self.assertIn("trap 'cleanup; exit 130' INT", self.body)
        self.assertIn("trap 'cleanup; exit 143' TERM", self.body)
        # The trap must be installed before the first sampler can start.
        self.assertLess(self.body.index('trap cleanup EXIT'),
                        self.body.index('sample_csv "$CSV" &'))


class BackupOrderingTests(unittest.TestCase):
    """A local prune must not run ahead of a verified off-host copy."""

    def setUp(self):
        self.body = (ROOT / 'infra/scripts/backup.sh').read_text()

    def test_pruning_is_gated_on_a_verified_upload(self):
        self.assertIn('UPLOAD_VERIFIED=false', self.body)
        self.assertIn('UPLOAD_VERIFIED=true', self.body)
        self.assertIn('skipping the local prune', self.body)

    def test_the_upload_is_confirmed_by_listing_the_objects(self):
        self.assertIn('aws s3 ls', self.body)
        self.assertIn('is not listed in', self.body)

    def test_a_failed_upload_stops_before_pruning(self):
        upload_at = self.body.index('the dump upload failed')
        prune_at = self.body.index('skipping the local prune')
        self.assertLess(upload_at, prune_at)


class LoadTestIsolationContractTests(unittest.TestCase):
    """The fixture must be owned by a run, so two runs cannot collide.

    Before run ownership every run used `loadtest-001@assetflow.test` onwards.
    A second concurrent run overwrote the first run's password, and `--delete`
    removed whichever rows matched - possibly another live run's. These are
    source-level pins: the behaviour itself is exercised against real PostgreSQL
    by infra/tests/integration/integration-loadtest.sh in CI.
    """

    def read(self, rel):
        return (ROOT / rel).read_text(encoding='utf-8')

    def test_the_seed_requires_a_run_id(self):
        seed = self.read('backend/prisma/seed-loadtest.ts')
        self.assertIn('requireRunId', seed)
        # A missing run id must be an error, not a silently shared namespace.
        self.assertIn('fixtures are owned by a run', seed)
        self.assertIn('LOADTEST_RUN_ID', seed)

    def test_identities_are_run_scoped(self):
        seed = self.read('backend/prisma/seed-loadtest.ts')
        self.assertIn('emailFor(runId', seed)
        k6 = self.read('infra/scripts/k6-load.js')
        self.assertIn('LOADTEST_RUN_ID', k6)
        # The old shared name must not remain in the address the driver signs in with.
        self.assertNotIn("`loadtest-${String(index).padStart(3, '0')}@assetflow.test`", k6)

    def test_the_run_id_is_embedded_in_every_asset_tag(self):
        seed = self.read('backend/prisma/seed-loadtest.ts')
        self.assertIn('"assetTag" LIKE ${tagPattern}', seed)
        self.assertIn('TAG_PREFIX}${runId}', seed)

    def test_delete_is_scoped_to_the_named_run(self):
        seed = self.read('backend/prisma/seed-loadtest.ts')
        # Deletion must use the exact per-run prefix, never a bare wildcard.
        self.assertIn('startsWith: `${EMAIL_PREFIX}${runId}-`', seed)
        self.assertIn('likeSafe', seed)

    def test_the_script_binds_the_target_before_ramping(self):
        script = self.read('infra/scripts/load-test.sh')
        self.assertIn('target binding failed', script)
        self.assertIn('LOADTEST_RUN_ID="$LOADTEST_RUN_ID"', script)
        # Binding must be a sign-in, which only the fixture's own database can satisfy.
        self.assertIn('/api/auth/login', script)
        # And it must run for single-user mode too, since it is about which system.
        self.assertNotIn('if [ "$SINGLE_USER" = false ] && [ "$LOADTEST_USERS" -gt 1 ]', script)

    def test_cleanup_is_registered_before_the_seed(self):
        script = self.read('infra/scripts/load-test.sh')
        trap_at = script.index('trap load_cleanup EXIT')
        seed_at = script.index('CLEANUP_REQUIRED=true')
        self.assertLess(trap_at, seed_at, 'an interrupted seed would leave its rows behind')

    def test_the_ramp_aborts_when_the_target_is_failing(self):
        k6 = self.read('infra/scripts/k6-load.js')
        self.assertIn('abortOnFail: true', k6)
        script = self.read('infra/scripts/load-test.sh')
        self.assertIn('ABORT_ERROR_RATE', script)
        self.assertIn('ABORTED', script)

    def test_the_live_load_gate_is_still_closed(self):
        script = self.read('infra/scripts/load-test.sh')
        self.assertIn('load execution disabled', script)
        self.assertIn('--dry-run remains available', script)


if __name__ == '__main__':
    unittest.main()
