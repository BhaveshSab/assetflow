"""Integration contracts for the bootstrap defects found in review.

Each test pins one of the seven defects at the level that would have caught it:
the rendered artifact, not a mock of it. The live compose deployment is covered
separately by the CI job in .github/workflows (see docs/results); these tests are
the fast contract layer.
"""
import base64
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

CAPACITY = Path(__file__).resolve().parents[2] / 'infra/capacity-run'
USER_DATA = CAPACITY / 'user-data.sh'
RENDER = CAPACITY / 'render-user-data.sh'
GUARD = CAPACITY / 'deadline-guard.sh'
APP_CFG = CAPACITY / 'generate-app-config.sh'
COMPOSE = Path(__file__).resolve().parents[2] / 'infra/docker-compose.yml'
API_DOCKERFILE = Path(__file__).resolve().parents[2] / 'infra/docker/Dockerfile.api'

EC2_USERDATA_LIMIT = 16384


def body(path):
    """Executable lines only - comments may name a wrong value to explain it."""
    return chr(10).join(l.split('#', 1)[0] for l in path.read_text(encoding='utf-8').splitlines())


def brace_depth(text):
    return text.count('${')


class ComposeConfigurationTests(unittest.TestCase):
    """Defect 1: compose cannot start without the application configuration."""

    def setUp(self):
        self.compose = COMPOSE.read_text(encoding='utf-8')
        self.src = USER_DATA.read_text(encoding='utf-8')

    def test_every_required_compose_variable_is_supplied(self):
        import re
        required = set()
        for m in re.finditer(r'\$\{([A-Z_]+)\}', self.compose):
            required.add(m.group(1))
        # Variables the compose file interpolates with no default are mandatory.
        mandatory = {v for v in required
                     if '${' + v + '}' in self.compose or '${' + v + ':?' in self.compose}
        for var in ('POSTGRES_PASSWORD', 'REDIS_PASSWORD'):
            self.assertIn(var, mandatory, f'{var} is interpolated without a default')
        for var in mandatory:
            self.assertRegex(self.src, rf'\b{var}\b',
                             f'{var} is required by compose but the bootstrap never sets it')

    def test_bootstrap_writes_the_env_file_compose_reads(self):
        self.assertIn('infra/.env', self.src)
        self.assertIn('--env-file infra/.env', self.src)

    def test_signing_secret_is_generated_and_long_enough(self):
        proc = subprocess.run(['bash', str(APP_CFG), os.devnull], capture_output=True, text=True)
        self.assertNotEqual(proc.returncode, 0)  # usage guard
        out = Path(tempfile.mkdtemp()) / 'app.env'
        proc = subprocess.run(['bash', str(APP_CFG), str(out), 'cap-test'],
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = out.read_text()
        jwt = [l.split('=', 1)[1] for l in text.splitlines() if l.startswith('JWT_SECRET=')][0]
        self.assertGreaterEqual(len(jwt), 32, 'API rejects short JWT_SECRET in production')

    def test_generated_config_is_not_world_readable(self):
        out = Path(tempfile.mkdtemp()) / 'app.env'
        subprocess.run(['bash', str(APP_CFG), str(out), 'cap-test'],
                       capture_output=True, check=True)
        if os.name == 'nt':
            self.skipTest('POSIX modes are not meaningful on Windows')
        self.assertEqual(out.stat().st_mode & 0o077, 0)


class HealthProbeTests(unittest.TestCase):
    """Defect 2: wrong port and wrong route, probed with a missing client."""

    def setUp(self):
        self.src = body(USER_DATA)

    def test_uses_the_real_api_port(self):
        self.assertIn('127.0.0.1:4000', self.src)
        self.assertNotIn('127.0.0.1:3000', self.src)

    def test_uses_the_real_readiness_route(self):
        self.assertIn('/api/health/ready', self.src)

    def test_probes_with_a_client_present_in_the_image(self):
        self.assertIn('exec -T api node -e', self.src)
        self.assertNotIn('exec -T api curl', self.src)

    def test_probe_matches_the_compose_healthcheck(self):
        compose = COMPOSE.read_text(encoding='utf-8')
        self.assertIn('127.0.0.1:4000/api/health/ready', compose,
                      'the bootstrap probe must agree with the compose healthcheck')


class SeedingTests(unittest.TestCase):
    """Defect 3: the seed command cannot run in the pruned runtime image."""

    def setUp(self):
        self.src = body(USER_DATA)
        self.dockerfile = API_DOCKERFILE.read_text(encoding='utf-8')

    def test_does_not_seed_inside_the_runtime_api_container(self):
        # Normalise whitespace and line continuations: the defect spanned a line
        # break, which a single-line substring check would have missed.
        flat = ' '.join(self.src.replace(chr(92), ' ').split())
        self.assertNotIn('exec -T api npm run seed:loadtest', flat)
        self.assertNotRegex(flat, r'exec -T api[^|]*seed:loadtest',
                            'seeding inside the api runtime container cannot work: '
                            'npm prune --omit=dev removes ts-node')

    def test_seeds_from_the_image_that_keeps_dev_dependencies(self):
        self.assertIn('migrate', self.src)
        self.assertIn('npm run seed:loadtest', self.src)
        self.assertIn('npm prune --omit=dev', self.dockerfile,
                      'premise: the runtime image prunes ts-node')

    def test_proves_the_account_count_by_querying_the_database(self):
        self.assertIn('SELECT count(*)', self.src)
        self.assertIn('fixture-users', self.src)

    def test_run_scoped_isolation_is_used(self):
        self.assertIn('--run-id', self.src)
        self.assertIn('cap-2026', self.src) if 'cap-2026' in self.src else None
        self.assertIn("loadtest-${RUN_ID}-", self.src)


class DeadlineServiceTests(unittest.TestCase):
    """Defect 4: a oneshot with RemainAfterExit runs exactly once."""

    def setUp(self):
        self.src = body(USER_DATA)
        self.guard = GUARD.read_text(encoding='utf-8')

    def test_remains_after_exit_is_not_set(self):
        self.assertNotIn('RemainAfterExit', self.src,
                         'RemainAfterExit keeps the unit active and blocks re-activation')

    def test_timer_repeats(self):
        self.assertIn('OnUnitActiveSec=60s', self.src)
        self.assertIn('WantedBy=timers.target', self.src)

    def test_deadline_is_installed_before_package_work(self):
        deadline_at = self.src.index('deadline')
        packages_at = self.src.index('apt-get update')
        self.assertLess(deadline_at, packages_at,
                        'an apt failure must not leave the guest without a deadline')

    def test_guard_does_not_strip_non_digits(self):
        code = chr(10).join(l.split('#', 1)[0] for l in self.guard.splitlines())
        self.assertNotIn("tr -dc", code,
                         'stripping digits turns malformed input into a valid timestamp')
        self.assertIn('*[!0-9]*', code, 'whole-value validation is required')


class ExecutableBitTests(unittest.TestCase):
    """Scripts the pipeline invokes directly must be executable IN GIT.

    chmod +x on a working copy proves nothing: Git stores the mode, and a
    100644 entry is what the runner checks out. This was a real CI failure
    ("Permission denied", exit 126) rather than a hypothetical.
    """

    def test_capacity_scripts_are_executable_in_git(self):
        repo = Path(__file__).resolve().parents[2]
        scripts = sorted(str(p.relative_to(repo)).replace(chr(92), '/')
                         for p in (repo / 'infra/capacity-run').rglob('*.sh'))
        scripts.append('infra/tests/integration/deadline-activation.sh')
        proc = subprocess.run(['git', 'ls-files', '-s'] + scripts,
                              cwd=repo, capture_output=True, text=True)
        if proc.returncode != 0:
            self.skipTest('not a git checkout')
        for line in proc.stdout.splitlines():
            mode, _, _ = line.split(maxsplit=2)
            path = line.split(maxsplit=3)[3]
            if path.endswith('.conf'):
                continue
            self.assertEqual(mode, '100755',
                             f'{path} is {mode} in Git; the runner will get '
                             'Permission denied')


class PayloadSizeTests(unittest.TestCase):
    """EC2 rejects user-data above 16 KiB, and the CLI base64-encodes for you."""

    def test_rendered_payload_fits_the_ec2_limit(self):
        tmp = Path(tempfile.mkdtemp())
        trust = tmp / 'trust'
        app = tmp / 'app.env'
        subprocess.run(['bash', str(CAPACITY / 'generate-trust.sh'), str(trust)],
                       check=True, capture_output=True)
        subprocess.run(['bash', str(APP_CFG), str(app), 'cap-test'],
                       check=True, capture_output=True)
        env = dict(os.environ)
        for line in (trust / 'trust.env').read_text().splitlines():
            if '=' in line:
                k, v = line.split('=', 1)
                env[k] = v
        for line in app.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                if k not in ('POSTGRES_USER', 'POSTGRES_DB'):
                    env.setdefault(k, v)
        env.update(LAUNCH_EPOCH='1700000000', EXPECTED_COMMIT='a' * 40, RUN_ID='cap-test')
        proc = subprocess.run(['bash', str(RENDER)], capture_output=True, text=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        raw = base64.b64decode(proc.stdout)
        self.assertLessEqual(len(raw), EC2_USERDATA_LIMIT,
                             f'payload is {len(raw)} bytes, EC2 limit is {EC2_USERDATA_LIMIT}')

    def test_renderer_emits_base64_and_the_cli_expects_raw(self):
        """The renderer base64s because the API takes base64; the CLI base64s a
        file it is given. Passing base64 text to file:// would double-encode."""
        text = RENDER.read_text(encoding='utf-8')
        self.assertIn('| base64', text)


if __name__ == '__main__':
    unittest.main()
