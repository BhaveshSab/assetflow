"""Exercise deploy orchestration with local stubs; no SSH, Docker or cloud access."""
import fcntl
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SHA = 'b' * 40
API = f'ghcr.io/example/assetflow-api:{SHA}'
MIGRATE = f'ghcr.io/example/assetflow-migrate:{SHA}'
WEB = f'ghcr.io/example/assetflow-web:{SHA}'
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/deploy.yml').read_text())
JOB = WORKFLOW['jobs']['deploy']
RUN = next(s['run'] for s in JOB['steps'] if s.get('name') == 'Deploy')
REMOTE = RUN.split("<<'REMOTE' | tee \"$out\"\n", 1)[1].split('\nREMOTE\n', 1)[0]


def executable(path, text):
    path.write_text('#!/usr/bin/env bash\nset -eu\n' + text)
    path.chmod(0o755)


class DeployWorkflowTests(unittest.TestCase):
    def test_all_release_images_are_published_from_same_commit(self):
        builds = [s['with'] for s in JOB['steps'] if s.get('uses', '').startswith('docker/build-push-action@')]
        self.assertEqual(len(builds), 3)
        self.assertEqual({s.get('target', 'web') for s in builds}, {'runtime', 'migrate', 'web'})
        self.assertTrue(all(s['push'] is True for s in builds))
        self.assertTrue(all(':${{ github.sha }}' in s['tags'] for s in builds))
        scopes = {s['cache-to'] for s in builds}
        self.assertEqual(len(scopes), 3)
        self.assertNotIn(' build nginx', RUN)
        compose = yaml.safe_load((ROOT / 'infra/docker-compose.yml').read_text())
        self.assertEqual(compose['services']['nginx']['image'], '${WEB_IMAGE:-ghcr.io/bhaveshsab/assetflow-web:latest}')

    def test_remote_and_client_deadlines_keepalives_and_main_only_dispatch(self):
        self.assertEqual(JOB['if'], "github.ref == 'refs/heads/main'")
        self.assertEqual(JOB['timeout-minutes'], 45)
        self.assertIn('timeout --signal=TERM --kill-after=30s 15m', RUN)
        self.assertIn('timeout --kill-after=30s 18m ssh', RUN)
        self.assertIn('ServerAliveInterval=15', RUN)
        self.assertIn('set -uo pipefail', RUN)
        subprocess.run(['bash', '-n'], input=REMOTE, text=True, check=True)
        for step in JOB['steps']:
            if 'run' in step:
                subprocess.run(['bash', '-n'], input=step['run'], text=True, check=True)
        self.assertEqual(next(s for s in JOB['steps'] if s.get('name') == 'Deploy')['timeout-minutes'], 20)

    def run_transport(self, status, omit_marker=False):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            executable(path / 'ssh', '''cat >/dev/null
printf '%s\n' "${@: -1}" > "$COMMAND_FILE"
echo LIVE_DEPLOY_LINE
echo REMOTE_ERROR_LINE >&2
if [ "$SSH_STATUS" = 0 ] && [ "$OMIT_MARKER" = 0 ]; then
  echo "ASSETFLOW_DEPLOY_COMPLETE ${IMAGE##*:}"
fi
exit "$SSH_STATUS"
''')
            # Isolate the runner log path too; production uses /tmp.
            run = RUN.replace('out=/tmp/deploy-remote.log', 'out="$OUT_FILE"')
            command = path / 'remote-command'
            result = subprocess.run(['bash', '-e', '-c', run], text=True, capture_output=True, timeout=5,
                env={**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}',
                     'HOST': 'invalid.test', 'USER': 'deploy', 'CONFIGURED_PATH': '/path with spaces',
                     'IMAGE': API, 'MIGRATE_IMAGE': MIGRATE, 'WEB_IMAGE': WEB,
                     'COMMAND_FILE': str(command), 'OUT_FILE': str(path / 'log'),
                     'SSH_STATUS': str(status), 'OMIT_MARKER': str(int(omit_marker))})
            # printf %q uses Bash ANSI-C quoting for a multiline bootstrap;
            # POSIX shlex cannot parse it. Decode the trusted test-generated
            # command with the same shell the remote endpoint uses.
            decoded = subprocess.check_output(
                ['bash', '-c', 'set -- ' + command.read_text() + '\nprintf "%s\\0" "$@"'],
            )
            return result, decoded.decode().rstrip('\0').split('\0')

    def test_ssh_failure_is_not_hidden_by_successful_tee(self):
        for status in [23, 124, 255]:
            with self.subTest(status=status):
                result, _ = self.run_transport(status)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('::error title=Deploy failed::', result.stdout)
                self.assertIn('REMOTE_ERROR_LINE', result.stdout)

    def test_remote_arguments_are_quoted_and_success_is_preserved(self):
        result, args = self.run_transport(0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(args[-4:], ['/path with spaces', API, MIGRATE, WEB])
        self.assertNotIn('::error', result.stdout)

    def test_ssh_zero_without_completion_is_a_failure(self):
        result, _ = self.run_transport(0, omit_marker=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('::error title=Incomplete deployment::', result.stdout)

    def test_remote_output_is_visible_before_ssh_finishes(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            executable(path / 'ssh', '''cat >/dev/null
echo LIVE_BEFORE_EXIT
while [ ! -f "$RELEASE" ]; do sleep 0.02; done
echo "ASSETFLOW_DEPLOY_COMPLETE ${IMAGE##*:}"
''')
            run = RUN.replace('out=/tmp/deploy-remote.log', 'out="$OUT_FILE"')
            process = subprocess.Popen(['bash', '-e', '-c', run], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, start_new_session=True,
                env={**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}', 'HOST': 'invalid.test',
                     'USER': 'deploy', 'CONFIGURED_PATH': '', 'IMAGE': API, 'MIGRATE_IMAGE': MIGRATE,
                     'WEB_IMAGE': WEB, 'RELEASE': str(path / 'release'), 'OUT_FILE': str(path / 'log')})
            try:
                ready, _, _ = select.select([process.stdout], [], [], 3)
                self.assertTrue(ready, 'log output was buffered until SSH completion')
                self.assertEqual(process.stdout.readline().strip(), 'LIVE_BEFORE_EXIT')
                self.assertIsNone(process.poll(), 'SSH must still be running when log is received')
                (path / 'release').touch()
                process.communicate(timeout=3)
                self.assertEqual(process.returncode, 0)
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGKILL)
                process.communicate()

    def test_final_verification_requires_200_not_redirect_or_503(self):
        run = next(s['run'] for s in JOB['steps'] if s.get('name') == 'Verify the deployment on the host')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            executable(path / 'ssh', 'bash -c "${@: -1}"\n')
            executable(path / 'curl', 'printf "%s" "$HTTP_STATUS"\n')
            executable(path / 'sleep', 'exit 0\n')
            for status in ['200', '301', '503']:
                with self.subTest(status=status):
                    result = subprocess.run(['bash', '-e', '-c', run], capture_output=True, text=True, timeout=5,
                        env={**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}', 'HOST': 'invalid.test',
                             'USER': 'deploy', 'HTTP_STATUS': status})
                    self.assertEqual(result.returncode, 0 if status == '200' else 1, result.stderr)
                    self.assertIn(f'readiness HTTP {status}', result.stdout)

    def test_host_lock_refuses_second_run_before_touching_checkout(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            state = path / 'assetflow'
            state.mkdir()
            with (state / 'deploy.lock').open('w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                result = subprocess.run(['bash', '-s', '--', str(path), API, MIGRATE, WEB],
                    input=REMOTE, text=True, capture_output=True, timeout=3,
                    env={**os.environ, 'XDG_STATE_HOME': str(path)})
            self.assertEqual(result.returncode, 2)
            self.assertIn('another deployment holds the host lock', result.stdout)


class DeployScriptTests(unittest.TestCase):
    def run_script(self, mode='healthy'):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            executable(path / 'docker', '''printf '%s\n' "$*" >> "$CALLS"
case "$1" in
  pull)
    if [ "$MODE" = missing-web ] && [ "$2" = "$WEB_IMAGE" ]; then exit 17; fi ;;
  inspect) echo ghcr.io/example/assetflow-api:previous ;;
  images) printf '%s\n' "$MIGRATE_IMAGE" "ghcr.io/example/assetflow-migrate:old" ;;
  compose)
    case "$*" in
      *'ps -q api') echo test-container ;;
      *'run --rm -T migrate')
        bytes=$(cat | wc -c)
        echo "migration_stdin_bytes=$bytes" >> "$CALLS"
        if [ "$MODE" = migration-fails ]; then exit 18; fi ;;
      *'exec -T prometheus'*)
        bytes=$(cat | wc -c)
        echo "monitoring_stdin_bytes=$bytes" >> "$CALLS" ;;
    esac ;;
esac
''')
            executable(path / 'curl', 'if [ "$MODE" = unhealthy ]; then printf 503; else printf 200; fi\n')
            executable(path / 'sleep', 'exit 0\n')
            executable(path / 'df', "printf 'Filesystem Size Used Avail Use%% Mounted on\\n/dev/mock 20000 2000 18000 10%% /\\n'\n")
            # Copy only operational scripts, so tests never source a real .env.
            repo = path / 'repo'
            scripts = repo / 'infra/scripts'
            (scripts / 'lib').mkdir(parents=True)
            (scripts / 'lib/common.sh').write_text((ROOT / 'infra/scripts/lib/common.sh').read_text())
            (scripts / 'deploy.sh').write_text((ROOT / 'infra/scripts/deploy.sh').read_text())
            # Explicit workflow pins must survive conflicting host defaults.
            (repo / 'infra/.env').write_text('IMAGE=wrong:latest\nMIGRATE_IMAGE=wrong-migrate:latest\nWEB_IMAGE=wrong-web:latest\n')
            calls = path / 'calls'
            result = subprocess.run(['bash', str(scripts / 'deploy.sh')], input='FAKE_CALLER_CONTROL_STREAM\n', capture_output=True, text=True, timeout=5,
                env={**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}', 'CALLS': str(calls),
                     'MODE': mode, 'IMAGE': API, 'MIGRATE_IMAGE': MIGRATE, 'WEB_IMAGE': WEB,
                     'LOG_FILE': str(path / 'log'), 'PREVIOUS_IMAGE_FILE': str(path / 'previous'),
                     'HEALTH_RETRIES': '1', 'JOBS_ENABLED': 'false'})
            return result, calls.read_text().splitlines()

    def test_release_pulls_all_pinned_images_before_migrations_and_never_builds(self):
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        for image in [API, MIGRATE, WEB]:
            self.assertIn(f'pull {image}', calls)
        migration = next(i for i, c in enumerate(calls) if 'run --rm' in c)
        self.assertTrue(all(calls.index(f'pull {image}') < migration for image in [API, MIGRATE, WEB]))
        self.assertIn('run --rm -T migrate', calls[migration])
        starts = [c for c in calls if 'up -d' in c]
        self.assertTrue(starts)
        self.assertTrue(all('--no-build' in c for c in starts))
        self.assertFalse(any(' build ' in c for c in calls))
        self.assertFalse(any('wrong' in c for c in calls))
        self.assertNotIn(f'rmi {MIGRATE}', calls, 'cleanup must retain the current migration image')

    def test_migration_and_monitoring_clients_are_detached_from_caller_stdin(self):
        result, calls = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('migration_stdin_bytes=0', calls)
        self.assertIn('monitoring_stdin_bytes=0', calls)

    def test_migration_never_passes_flags_compose_run_rejects(self):
        """`docker compose run` has no --no-build; passing it aborts every deploy.

        The flag belongs to `docker compose up`. A deploy failed for real with
        `unknown flag: --no-build` at the migration step, so assert on the CLI
        contract instead of on one exact command string.
        """
        script = (ROOT / 'infra/scripts/deploy.sh').read_text().splitlines()
        runs = [
            line
            for line in script
            if 'compose run' in line and not line.lstrip().startswith('#')
        ]
        self.assertTrue(runs, 'deploy.sh must run the migrations')
        for line in runs:
            self.assertNotIn('--no-build', line, f'--no-build is invalid for `compose run`: {line.strip()}')
            # `run --pull` only exists on newer Compose plugins, and the host's
            # version is not pinned here; the pinned tag comes from MIGRATE_IMAGE.
            self.assertNotIn('--pull', line, f'--pull is not portable on `compose run`: {line.strip()}')
            self.assertIn('MIGRATE_IMAGE=', line, f'the migration run must use the pinned image: {line.strip()}')

    def test_missing_web_or_failed_migration_does_not_replace_running_api(self):
        for mode in ['missing-web', 'migration-fails']:
            with self.subTest(mode=mode):
                result, calls = self.run_script(mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse(any('up -d' in c for c in calls))
                if mode == 'missing-web':
                    self.assertFalse(any('run --rm' in c for c in calls))

    def test_unhealthy_api_still_attempts_rollback_without_building(self):
        result, calls = self.run_script('unhealthy')
        self.assertEqual(result.returncode, 1)
        self.assertIn('rolling back', result.stdout + result.stderr)
        starts = [c for c in calls if 'up -d' in c]
        self.assertEqual(len(starts), 2)
        self.assertTrue(all('--no-build --pull never api' in c for c in starts))


if __name__ == '__main__':
    unittest.main()
