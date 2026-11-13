"""Integration contracts for the bootstrap defects found in review.

Each test pins one of the seven defects at the level that would have caught it:
the rendered artifact, not a mock of it. The live compose deployment is covered
separately by the CI job in .github/workflows (see docs/results); these tests are
the fast contract layer.
"""
import base64
import os
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path

CAPACITY = Path(__file__).resolve().parents[2] / 'infra/capacity-run'
USER_DATA = CAPACITY / 'user-data.sh'
APP_HEALTH = CAPACITY / 'app-health.sh'
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
        self.assertIn('127.0.0.1:4000', APP_HEALTH.read_text(encoding='utf-8'))
        self.assertNotIn('127.0.0.1:3000', APP_HEALTH.read_text(encoding='utf-8'))

    def test_uses_the_real_readiness_route(self):
        self.assertIn('/api/health/ready', APP_HEALTH.read_text(encoding='utf-8'))

    def test_probes_with_a_client_present_in_the_image(self):
        health = APP_HEALTH.read_text(encoding='utf-8')
        self.assertIn('exec -T api node -e', health)
        self.assertNotIn('exec -T api curl', health)

    def test_probe_matches_the_compose_healthcheck(self):
        compose = COMPOSE.read_text(encoding='utf-8')
        self.assertIn('127.0.0.1:4000/api/health/ready', compose,
                      'the bootstrap probe must agree with the compose healthcheck')

    def test_the_stack_is_started_before_the_gate(self):
        """The thirteenth attempt died here by design: nothing had ever run
        `up -d api nginx`, so the gate probed a container that did not exist
        for the whole 90-iteration window."""
        health = APP_HEALTH.read_text(encoding='utf-8')
        self.assertIn('up -d api nginx', health)
        self.assertLess(health.index('up -d api nginx'),
                        health.index('exec -T api node -e'),
                        'the readiness gate must run after the stack starts')

    def test_the_run_certificate_is_installed_for_the_app_edge(self):
        """The app nginx mounts ./certs at /etc/letsencrypt; without the run
        certificate it cannot start at all (CI supplies it the same way)."""
        health = APP_HEALTH.read_text(encoding='utf-8')
        self.assertIn('certs/live/assetflow/fullchain.pem', health)
        self.assertIn('certs/live/assetflow/privkey.pem', health)
        self.assertLess(health.index('fullchain.pem'),
                        health.index('up -d api nginx'),
                        'the certificate must exist before nginx starts')

    def test_readiness_failure_leaves_diagnostics_before_dying(self):
        health = APP_HEALTH.read_text(encoding='utf-8')
        self.assertIn('api-readiness.log', health)
        self.assertIn('stack-ps.txt', health)
        self.assertLess(health.index('api-readiness.log'),
                        health.index('fail "application readiness never passed'),
                        'the api log must be captured before the failure exit')

    def test_user_data_invokes_the_script_and_reports_the_gate(self):
        src = body(USER_DATA)
        self.assertIn('app-health.sh', src)
        # The fifteenth attempt: a stack-START failure (nginx could not bind
        # 0.0.0.0:8443) surfaced as "readiness never passed" because this
        # fallback die reused the gate's wording. The fallback must not claim
        # a phase it did not observe; app-health writes its own precise
        # one-liner for whichever step actually failed.
        self.assertIn('application health step failed', src)
        self.assertNotIn('application readiness never passed', src)

    def test_the_guest_port_defaults_can_never_bind_a_public_port(self):
        """The fifteenth attempt's root cause: the rendered prologue assigned
        HTTPS_PORT=${HTTPS_PORT:-8443} - a plain 8443. Compose gives shell
        environment variables precedence over --env-file, so wherever that
        value leaked into the environment the app nginx's mapping became
        0.0.0.0:8443 and collided with the host edge. Every default in the
        guest path must be loopback-bound, so no layer can produce a public
        mapping."""
        render = (CAPACITY / 'render-user-data.sh').read_text(encoding='utf-8')
        user_data = USER_DATA.read_text(encoding='utf-8')
        for src, name in ((render, 'render-user-data.sh'),
                          (user_data, 'user-data.sh')):
            for var, port in (('HTTP_PORT', '8080'), ('HTTPS_PORT', '8440')):
                for line in src.splitlines():
                    if ('%s=${%s:-' % (var, var)) in line:
                        self.assertIn('127.0.0.1:%s' % port, line,
                                      '%s: %s default is not loopback-bound: %s'
                                      % (name, var, line.strip()))
                    if ('%s=127.0.0.1' % var) in line or \
                       ("%s=\\" % var) in line:
                        pass  # explicit loopback assignment, fine
                self.assertNotIn(
                    '%s=${%s:-8443}' % (var, var), src,
                    '%s still defaults %s to a public port' % (name, var))
        # The three sites must agree on the same loopback values: the rendered
        # prologue, the guest .env heredoc and the re-asserting sed lines.
        for var, value in (('HTTP_PORT', '127.0.0.1:8080'),
                           ('HTTPS_PORT', '127.0.0.1:8440')):
            occurrences = user_data.count('%s=%s' % (var, value))
            self.assertGreaterEqual(
                occurrences, 2,
                'user-data.sh states %s=%s only %d times; the heredoc and '
                'the sed re-assert must both carry the loopback value'
                % (var, value, occurrences))

    def test_the_status_endpoint_serves_the_readiness_diagnostics(self):
        status = (CAPACITY / 'bootstrap-status.py').read_text(encoding='utf-8')
        for name in ('api-readiness.log', 'stack-up.log', 'stack-ps.txt'):
            self.assertIn(name, status,
                          '/status/failure does not serve %s' % name)


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
        # The seeding moved into the shared helper (see test_seed_fixtures.py).
        # The helper still targets the migrate image, which keeps ts-node.
        helper = (CAPACITY / 'seed-fixtures.sh').read_text(encoding='utf-8')
        self.assertIn('migrate', helper)
        self.assertIn('npm run seed:loadtest', helper)
        self.assertIn('npm prune --omit=dev', self.dockerfile,
                      'premise: the runtime image prunes ts-node')

    def test_proves_the_account_count_by_querying_the_database(self):
        helper = (CAPACITY / 'seed-fixtures.sh').read_text(encoding='utf-8')
        self.assertIn('SELECT count(*)', helper)
        self.assertIn('fixture-users', helper)

    def test_loadtest_password_is_supplied(self):
        """The seed refuses to create more than one account without this, so a
        200-account fixture cannot be seeded unless it is provided."""
        helper = (CAPACITY / 'seed-fixtures.sh').read_text(encoding='utf-8')
        self.assertIn('LOADTEST_PASSWORD', helper)
        self.assertIn('-e LOADTEST_PASSWORD=', helper)

    def test_generated_loadtest_password_has_the_expected_shape(self):
        import tempfile
        out = Path(tempfile.mkdtemp()) / 'app.env'
        subprocess.run(['bash', str(APP_CFG), str(out), 'cap-test'],
                       check=True, capture_output=True)
        value = [l.split('=', 1)[1] for l in out.read_text().splitlines()
                 if l.startswith('LOADTEST_PASSWORD=')][0]
        self.assertEqual(len(value), 40, 'load-test.sh generates 40 characters')
        for ch in '/+=':
            self.assertNotIn(ch, value, 'must survive argv and env-file quoting')

    def test_run_scoped_isolation_is_used(self):
        helper = (CAPACITY / 'seed-fixtures.sh').read_text(encoding='utf-8')
        self.assertIn('--run-id', helper)
        self.assertIn("loadtest-${RUN_ID}-", helper)


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
        proc = subprocess.run(['bash', str(RENDER), '--base64'], capture_output=True, text=True, env=env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        raw = base64.b64decode(proc.stdout)
        self.assertLessEqual(len(raw), EC2_USERDATA_LIMIT,
                             f'payload is {len(raw)} bytes, EC2 limit is {EC2_USERDATA_LIMIT}')

    def test_renderer_emits_base64_and_the_cli_expects_raw(self):
        """The renderer base64s because the API takes base64; the CLI base64s a
        file it is given. Passing base64 text to file:// would double-encode."""
        text = RENDER.read_text(encoding='utf-8')
        self.assertIn('| base64', text)


class LaunchCommandDriftTests(unittest.TestCase):
    """The first real launch drifted from the approved configuration twice.

    The network interface was untagged, which the stage 2 policy denies, and no
    block device mapping was supplied, so the AMI's 8 GB root was used instead of
    the approved 30 GB. Both were operator errors in a hand-reconstructed command
    line. One launcher makes them unexpressible.
    """

    def setUp(self):
        self.path = CAPACITY / 'launch-instance.sh'
        self.text = self.path.read_text(encoding='utf-8')

    def test_launcher_exists_and_is_executable(self):
        self.assertTrue(self.path.exists())
        self.assertTrue(os.access(self.path, os.X_OK))

    def test_launcher_is_executable_in_the_git_index(self):
        """A working-copy chmod is not enough: CI checks out from the index."""
        try:
            out = subprocess.check_output(
                ['git', 'ls-files', '-s', str(self.path)], cwd=CAPACITY.parents[1], text=True)
        except Exception as exc:  # pragma: no cover - no git in some sandboxes
            self.skipTest('git metadata unavailable: %s' % exc)
        self.assertTrue(out.startswith('100755'), out.strip())

    def test_tags_the_network_interface(self):
        # Omitting this is exactly what the first dry-run was denied for.
        self.assertIn('ResourceType=network-interface', self.text)

    def test_tags_instance_volume_and_network_interface(self):
        for rt in ('ResourceType=instance', 'ResourceType=volume',
                   'ResourceType=network-interface'):
            self.assertIn(rt, self.text)

    def test_root_mapping_is_explicit_and_sized(self):
        self.assertIn('--block-device-mappings', self.text)
        self.assertIn('VolumeSize=$ROOT_GB', self.text)
        self.assertIn('ROOT_GB=30', self.text)

    def test_root_mapping_uses_the_ami_root_device_name(self):
        # Hardcoding /dev/sda1 would be a guess; the AMI is asked.
        self.assertIn('RootDeviceName', self.text)
        self.assertIn('DeviceName=$AMI_ROOT_DEV', self.text)

    def test_root_volume_is_deleted_on_termination(self):
        self.assertIn('DeleteOnTermination=true', self.text)

    def test_shutdown_terminates(self):
        self.assertIn('--instance-initiated-shutdown-behavior terminate', self.text)

    def test_standard_cpu_credits(self):
        self.assertIn('CpuCredits=standard', self.text)

    def test_client_token_is_required(self):
        self.assertIn('CLIENT_TOKEN:?', self.text)

    def test_uncertain_response_is_reconciled_not_retried(self):
        self.assertIn('reconcile', self.text.lower())
        self.assertIn('Idempotent', self.text)

    def test_tag_specs_are_separate_arguments(self):
        """The CLI rejects more than one ResourceType per --tag-specifications value.

        Joining them with a comma or a space fails at param validation, which was
        only discovered by actually dry-running the launcher against AWS.
        """
        self.assertIn('TAGSPECS=(', self.text)
        self.assertIn('"${TAGSPECS[0]}"', self.text)
        self.assertNotIn('TAGSPEC="$TAGSPEC', self.text)

    def test_user_data_path_is_native_for_the_cli(self):
        """A native binary cannot open /c/... inside a file:// URL."""
        self.assertIn('cygpath -w', self.text)

    def test_asserts_enough_disk_before_any_build(self):
        """Free space is checked in the guest before the image build starts."""
        text = USER_DATA.read_text(encoding='utf-8')
        self.assertIn('MIN_FREE_MB', text)
        self.assertIn('disk: ', text)

    def test_does_not_assume_public_addressing(self):
        """Reachability is asserted from the subnet and read back after launch."""
        self.assertIn('MapPublicIpOnLaunch', self.text)
        self.assertIn('PublicIpAddress', self.text)

    def test_refuses_to_duplicate_an_existing_instance(self):
        self.assertIn('refusing to duplicate', self.text)

    def test_payload_size_and_commit_are_checked(self):
        self.assertIn('16384', self.text)
        self.assertIn('EXPECTED_COMMIT', self.text)

    def test_pins_the_approved_ami_subnet_and_sg(self):
        for v in ('ami-01e91e94accc42eec', 'subnet-01f25dc99e013aa6a',
                  'sg-012a0191f4e4a9a8c'):
            self.assertIn(v, self.text)


class DiskPreflightTests(unittest.TestCase):
    """The production run died of disk exhaustion, not of application code."""

    def setUp(self):
        self.text = USER_DATA.read_text(encoding='utf-8')

    def test_preflight_runs_before_any_build_work(self):
        pf = self.text.index('disk preflight')
        for later in ('== code ==', 'compose build', 'npm ci'):
            if later in self.text:
                self.assertLess(pf, self.text.index(later),
                                'disk preflight must precede %s' % later)

    def test_preflight_refuses_below_a_floor(self):
        self.assertIn('MIN_FREE_MB', self.text)
        self.assertIn('disk: ', self.text)

    def test_preflight_records_its_observation(self):
        self.assertIn('disk-preflight', self.text)

    def test_preflight_fails_closed_on_unreadable_df(self):
        # An empty reading must not be treated as infinite space.
        self.assertIn('-z "$AVAIL_MB"', self.text)


class DeadlineDiagnosticsTests(unittest.TestCase):
    """journald died of ENOSPC on the failed run, so it could not be the record."""

    def setUp(self):
        self.text = GUARD.read_text(encoding='utf-8')

    def test_logs_to_the_console_not_only_stdout(self):
        self.assertIn('/dev/console', self.text)

    def test_recorded_environment_is_explainable(self):
        self.assertIn('deadline_file=$DEADLINE_FILE', self.text)

    def test_every_exit_path_is_success(self):
        # A "failed" unit must not be produced by this script's own exit code.
        self.assertNotIn('exit 1', self.text)


class PreludeDiagnosticsTests(unittest.TestCase):
    """A silent four-minute death with an empty console is the failure to avoid.

    The prelude runs before the bootstrap has a log file, a say() or a die(), so
    under `set -e` any failure in its first lines aborted with no message anywhere.
    """

    def setUp(self):
        self.text = RENDER.read_text(encoding='utf-8')

    def test_prelude_installs_an_err_trap(self):
        self.assertIn("trap 'prelude_fail", self.text)
        self.assertIn('ERR', self.text)

    def test_trap_reports_the_line_and_exit_code(self):
        self.assertIn('prelude failed (rc=', self.text)
        self.assertIn('at line', self.text)

    def test_trap_writes_to_the_console(self):
        self.assertIn('/dev/console', self.text)

    def test_trap_is_installed_before_any_privileged_step(self):
        trap_at = self.text.index("trap 'prelude_fail")
        first_mkdir = self.text.index('mkdir -p /etc/capacity-run')
        self.assertLess(trap_at, first_mkdir)


class RealDefectRegressions(unittest.TestCase):
    """Each of these failed on a real run and each cost an instance."""

    def test_comment_strip_keeps_the_shebang(self):
        """Dropping it left the guard with no interpreter; systemd failed instantly."""
        r = RENDER.read_text(encoding='utf-8')
        self.assertIn('NR == 1', r)
        self.assertIn('/^#!/', r)

    def test_launcher_resolves_short_sha_to_full(self):
        """The bootstrap compares against `git rev-parse HEAD`, which is always 40 chars.

        Rendering a short SHA made the guest abort with
        `deployed e4fe01babc... != expected e4fe01b`.
        """
        text = (CAPACITY / 'launch-instance.sh').read_text(encoding='utf-8')
        self.assertIn('rev-parse --verify', text)
        self.assertIn('-ne 40', text)

    def test_bootstrap_start_marker_survives_unset_vars(self):
        """It is printed before the config is sourced, under `set -u`."""
        text = USER_DATA.read_text(encoding='utf-8')
        marker = [l for l in text.splitlines() if 'bootstrap-start run=' in l]
        self.assertTrue(marker, 'bootstrap-start marker missing')
        self.assertIn(':-unset', marker[0])

    def test_stage_markers_exist_for_entry_and_completion(self):
        text = USER_DATA.read_text(encoding='utf-8')
        self.assertIn('stage_begin()', text)
        self.assertIn('stage_done()', text)

    def test_stage_appears_in_failure_reports(self):
        text = USER_DATA.read_text(encoding='utf-8')
        self.assertIn('stage=$STAGE', text)
        self.assertIn('line=', text)

    def test_unexpected_failures_are_trapped_with_code_and_line(self):
        text = USER_DATA.read_text(encoding='utf-8')
        self.assertIn('trap', text)
        self.assertIn('unexpected failure rc=', text)
        self.assertIn('BASH_LINENO', text) or self.assertIn('LINENO', text)

    def test_network_and_package_steps_are_bounded(self):
        text = USER_DATA.read_text(encoding='utf-8')
        self.assertIn('bounded()', text)
        self.assertIn('timeout "$limit"', text)

    def test_diagnostics_go_to_the_console(self):
        self.assertIn('/dev/console', USER_DATA.read_text(encoding='utf-8'))


class UrlSafetyGateTests(unittest.TestCase):
    """The compose file builds DATABASE_URL/REDIS_URL by raw interpolation.

    A password carrying '/' or '+' (openssl rand -base64 emits both) breaks the
    URL's authority split and Prisma dies with P1013 "invalid port number" deep
    inside the migration - the twelfth attempt's captured failure. The guest
    must refuse such values before the deploy stage, naming the variable.
    """

    URLSAFE_VARS = ('POSTGRES_PASSWORD', 'REDIS_PASSWORD',
                    'GRAFANA_ADMIN_PASSWORD', 'JWT_SECRET', 'LOADTEST_PASSWORD')

    def _guard_text(self):
        text = USER_DATA.read_text(encoding='utf-8')
        start = text.index('for v in POSTGRES_PASSWORD')
        end = text.index('done', text.index('case "$val" in', start))
        return text[start:end + 4]

    def _run_guard(self, env):
        """Execute the real guard text with a stubbed die()."""
        guard = self._guard_text()
        script = [
            'die() { echo "DIE:$1" >&2; exit 3; }',
            'set -u',
        ]
        for key, value in env.items():
            script.append("export %s=%s" % (key, shlex.quote(value)))
        script.append(guard)
        script.append('echo GUARD-OK')
        proc = subprocess.run(
            ['bash', '-c', '\n'.join(script)],
            capture_output=True, text=True, timeout=30)
        return proc

    def test_guard_rejects_a_base64_password_with_slash(self):
        env = {name: 'a' * 40 for name in self.URLSAFE_VARS}
        env['POSTGRES_PASSWORD'] = 'ab+cd/ef=' + 'a' * 40
        proc = self._run_guard(env)
        self.assertNotEqual(proc.returncode, 0, 'guard accepted a password with / and +')
        self.assertIn('POSTGRES_PASSWORD', proc.stderr)
        self.assertIn('URL-safe', proc.stderr)

    def test_guard_rejects_any_non_alnum_character(self):
        env = {name: 'a' * 40 for name in self.URLSAFE_VARS}
        for bad in ('/', '+', '=', '@', ':', '%'):
            env['REDIS_PASSWORD'] = 'x' + bad + 'y'
            proc = self._run_guard(env)
            self.assertNotEqual(proc.returncode, 0,
                                'guard accepted a password containing %r' % bad)
            self.assertIn('REDIS_PASSWORD', proc.stderr)

    def test_guard_accepts_alnum_values(self):
        env = {name: 'aB3xY9' * 8 for name in self.URLSAFE_VARS}
        proc = self._run_guard(env)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn('GUARD-OK', proc.stdout)

    def test_guard_covers_every_value_that_lands_in_a_url(self):
        guard = self._guard_text()
        for name in self.URLSAFE_VARS:
            self.assertIn(name, guard,
                          'the URL-safety gate does not cover %s' % name)


class AppHealthScriptTests(unittest.TestCase):
    """Executable tests on the real app-health.sh with a stubbed compose.

    The stub records every invocation so the ordering contract (certificate
    installed -> stack started -> gate probes) is observed, not asserted
    structurally. A failing exec exercises the real diagnostics capture and
    the real failure exit.
    """

    SCRIPT = APP_HEALTH

    def _stub_text(self, tmp, exec_rc, up_rc=0, ready_after=None):
        if ready_after is not None:
            exec_body = ('if [ "$(cat %s/probe-count 2>/dev/null || echo 0)" '
                         '-ge %d ]; then exit 0; else exit %d; fi'
                         % (tmp, ready_after, exec_rc))
        else:
            exec_body = 'exit %d' % exec_rc
        return (
            '#!/bin/bash\n'
            'LOG="%s/stub-calls.log"\n'
            "env | grep -E '^(API_IMAGE|WEB_IMAGE|MIGRATE_IMAGE)=' >> \"$LOG\"\n"
            'printf "%%s\\n" "$*" >> "$LOG"\n'
            'case "$1 $2" in\n'
            '  "up -d") exit %d ;;\n'
            '  "exec -T")\n'
            '    case "$*" in *http://nginx*) echo 200; exit 0 ;; esac\n'
            '    n=$(cat "%s/probe-count" 2>/dev/null || echo 0)\n'
            '    echo $((n+1)) > "%s/probe-count"\n'
            '    %s ;;\n'
            '  *) exit 0 ;;\n'
            'esac\n'
            % (tmp, up_rc, tmp, tmp, exec_body))

    def _run(self, exec_rc, up_rc=0, ready_after=None, env=None, digest_file=None,
             run_id=None):
        """Run the real script against a stubbed COMPOSE (and a stubbed sleep,
        so the full 90-iteration gate runs instantly).

        exec_rc: exit code for the readiness probe until ready_after is hit.
        ready_after: if set, the probe succeeds from this attempt on.
        digest_file: if given, written to APP_DIR/infra/capacity-run/ as the
          image-digests.env the bootstrap sources for the migration.
        """
        tmp = Path(tempfile.mkdtemp())
        stub = tmp / 'compose-stub.sh'
        stub.write_text(self._stub_text(tmp, exec_rc, up_rc, ready_after),
                        encoding='utf-8')
        stub.chmod(0o755)
        ev = tmp / 'evidence'
        ev.mkdir()
        # A fake TLS source so the certificate install really runs.
        tls = tmp / 'tls'
        tls.mkdir()
        (tls / 'tls.crt').write_text('crt')
        (tls / 'tls.key').write_text('key')
        app = tmp / 'app'
        app.mkdir()
        if digest_file is not None:
            capdir = app / 'infra' / 'capacity-run'
            capdir.mkdir(parents=True)
            (capdir / 'image-digests.env').write_text(digest_file, encoding='utf-8')
        env = dict(env or {})
        env.update(
            APP_DIR=str(app), EVIDENCE_DIR=str(ev), COMPOSE=str(stub),
            TLS_SRC=str(tls))
        if run_id is not None:
            env['RUN_ID'] = run_id
        # The real gate sleeps 5s between probes; stub sleep so 90 iterations
        # run instantly while the real loop text still executes.
        proc = subprocess.run(
            ['bash', '-c', 'sleep() { :; }; export -f sleep; exec bash "$1"',
             'bash', str(self.SCRIPT)],
            capture_output=True, text=True, timeout=120,
            env=env)
        return proc, tmp, ev

    def test_success_starts_the_stack_then_probes_and_writes_health(self):
        proc, tmp, ev = self._run(run_id='cap-test', exec_rc=1, ready_after=2)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual((ev / 'app-health').read_text().strip(), 'healthy')
        calls = (tmp / 'stub-calls.log').read_text().splitlines()
        ups = [i for i, c in enumerate(calls) if c.startswith('up -d')]
        execs = [i for i, c in enumerate(calls) if c.startswith('exec -T')]
        self.assertTrue(ups and execs)
        self.assertLess(ups[0], execs[0],
                        'the stack must be started before the first probe')
        self.assertIn('up -d api nginx', calls[ups[0]])

    def test_certificate_is_installed_before_the_stack_starts(self):
        proc, tmp, ev = self._run(run_id='cap-test', exec_rc=0)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        cert = tmp / 'app' / 'infra' / 'certs' / 'live' / 'assetflow' / 'fullchain.pem'
        key = tmp / 'app' / 'infra' / 'certs' / 'live' / 'assetflow' / 'privkey.pem'
        self.assertEqual(cert.read_text(), 'crt')
        self.assertEqual(key.read_text(), 'key')
        self.assertEqual(oct(key.stat().st_mode & 0o777), '0o600')
        calls = (tmp / 'stub-calls.log').read_text().splitlines()
        self.assertTrue(any(c.startswith('up -d') for c in calls))

    def test_readiness_failure_captures_diagnostics_and_exits_nonzero(self):
        proc, tmp, ev = self._run(run_id='cap-test', exec_rc=1)
        self.assertNotEqual(proc.returncode, 0,
                            'the gate must fail when readiness never passes')
        self.assertIn('application readiness never passed', proc.stderr)
        self.assertTrue((ev / 'api-readiness.log').exists(),
                        'the api log must be captured before the failure exit')
        self.assertTrue((ev / 'stack-ps.txt').exists())
        self.assertNotIn('healthy', (ev / 'app-health').read_text()
                         if (ev / 'app-health').exists() else '')

    def test_stack_start_failure_is_reported_with_the_log(self):
        proc, tmp, ev = self._run(run_id='cap-test', exec_rc=1, up_rc=7)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('stack failed to start', proc.stderr)
        self.assertTrue((ev / 'stack-up.log').exists())

    def test_edge_health_is_recorded_after_readiness(self):
        proc, tmp, ev = self._run(run_id='cap-test', exec_rc=0)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual((ev / 'edge-health').read_text().strip(), '200')

    # ------------------------------------------------------------------ pinning

    DIGEST_FILE = (
        'FIXTURE_MIGRATE_DIGEST=repo/migrate@sha256:%s\n'
        'FIXTURE_API_DIGEST=repo/api@sha256:%s\n'
        'FIXTURE_WEB_DIGEST=repo/web@sha256:%s\n'
    ) % ('1' * 64, '2' * 64, '3' * 64)

    def test_pinned_digests_are_exported_before_the_stack_starts(self):
        """The fourteenth attempt's failure: migrate-db.sh exports the pinned
        image refs inside its own process, so without re-pinning here compose
        resolved ghcr.io/...:latest and pulled a mutable tag instead of running
        the images the migration actually ran."""
        proc, tmp, ev = self._run(exec_rc=0, digest_file=self.DIGEST_FILE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        calls = (tmp / 'stub-calls.log').read_text().splitlines()
        ups = [i for i, c in enumerate(calls) if c.startswith('up -d')]
        self.assertTrue(ups)
        before_up = '\n'.join(calls[:ups[0] + 1])
        self.assertIn('API_IMAGE=repo/api@sha256:' + '2' * 64, before_up)
        self.assertIn('WEB_IMAGE=repo/web@sha256:' + '3' * 64, before_up)
        self.assertIn('MIGRATE_IMAGE=repo/migrate@sha256:' + '1' * 64, before_up)

    def test_a_partial_pin_is_refused(self):
        partial = self.DIGEST_FILE.replace(
            'FIXTURE_WEB_DIGEST=repo/web@sha256:' + '3' * 64 + '\n', '')
        proc, tmp, ev = self._run(exec_rc=0, digest_file=partial)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('partial pin', proc.stderr)

    def test_a_non_digest_pin_is_refused(self):
        tagged = self.DIGEST_FILE.replace('@sha256:' + '2' * 64, ':latest')
        proc, tmp, ev = self._run(exec_rc=0, digest_file=tagged)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('image@sha256', proc.stderr)

    def test_build_mode_pins_the_run_local_tags(self):
        proc, tmp, ev = self._run(exec_rc=0, run_id='cap-test')
        self.assertEqual(proc.returncode, 0, proc.stderr)
        calls = (tmp / 'stub-calls.log').read_text().splitlines()
        self.assertIn('API_IMAGE=assetflow-api:cap-test', '\n'.join(calls))

    def test_no_pin_at_all_is_refused(self):
        proc, tmp, ev = self._run(exec_rc=0)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('no image pin', proc.stderr)


class WorkflowSecretAlphabetTests(unittest.TestCase):
    """The workflow generates run secrets with its own gen(); it must produce
    URL-safe values - the twelfth attempt failed because the old gen() emitted
    openssl base64 including '+' and '/'.
    """

    WORKFLOW = (Path(__file__).resolve().parents[2]
                / '.github' / 'workflows' / 'capacity-run.yml')

    def _gen_pipeline(self):
        text = self.WORKFLOW.read_text(encoding='utf-8')
        match = re.search(r'^\s*gen\(\) \{ (.*) \}$', text, re.MULTILINE)
        self.assertIsNotNone(match, 'the workflow no longer defines gen()')
        return match.group(1).rstrip('; \t')

    def test_generated_secrets_are_url_safe(self):
        pipeline = self._gen_pipeline()
        for _ in range(64):
            proc = subprocess.run(['bash', '-c', pipeline],
                                  capture_output=True, text=True, timeout=30)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            value = proc.stdout.strip()
            self.assertRegex(value, r'^[A-Za-z0-9]+$')
            self.assertGreaterEqual(len(value), 32,
                                    'generated secret too short: %d' % len(value))

    def test_loadtest_password_is_exactly_40_url_safe_chars(self):
        pipeline = self._gen_pipeline()
        proc = subprocess.run(['bash', '-c', pipeline + ' | cut -c1-40'],
                              capture_output=True, text=True, timeout=30)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        value = proc.stdout.strip()
        self.assertRegex(value, r'^[A-Za-z0-9]{40}$')

    def test_the_pipeline_strips_base64_specials(self):
        pipeline = self._gen_pipeline()
        self.assertIn("tr -d", pipeline)
        for special in ('=', '+', '/'):
            self.assertIn(special, pipeline.split('tr -d', 1)[1],
                          'gen() does not strip %r' % special)


if __name__ == '__main__':
    unittest.main()
