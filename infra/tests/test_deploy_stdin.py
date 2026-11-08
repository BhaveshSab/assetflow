"""Real Bash transport regressions, plus a disposable real-Compose stdin test.

No cloud access. Docker is stubbed for orchestration tests, not Bash/timeout.
When Docker is installed (infra CI), one extra test uses an isolated project.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SHA = 'b' * 40
API = f'ghcr.io/test/assetflow-api:{SHA}'
MIGRATE = f'ghcr.io/test/assetflow-migrate:{SHA}'
WEB = f'ghcr.io/test/assetflow-web:{SHA}'
WORKFLOW = yaml.safe_load((ROOT / '.github/workflows/deploy.yml').read_text())
RUN = next(s['run'] for s in WORKFLOW['jobs']['deploy']['steps'] if s.get('name') == 'Deploy')


def executable(path, text):
    path.write_text('#!/usr/bin/env bash\nset -eu\n' + text)
    path.chmod(0o755)


def bootstrap():
    # Evaluate only the checked-in, locally authored bootstrap construction.
    fragment = RUN[RUN.index("remote_bootstrap=$(cat"):RUN.index('printf -v remote_command')]
    return subprocess.check_output(['bash', '-c', fragment + '\nprintf "%s" "$remote_bootstrap"'], text=True)


class DeployStdinTests(unittest.TestCase):
    def run_remote(self, mode='healthy'):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            repo = path / 'checkout with spaces'
            scripts = repo / 'infra/scripts'
            scripts.mkdir(parents=True)
            (repo / 'infra/docker-compose.yml').write_text('services: {}\n')
            # Act like a stdin-attaching Compose client inside deploy.sh.
            executable(scripts / 'deploy.sh', '''echo DEPLOY_CHILD_STARTED
cat > "$DRAINED"
echo DEPLOY_CHILD_FINISHED
[ "$MODE" != deploy-fails ]
''')
            executable(path / 'ssh', 'exec bash -c "${@: -1}"\n')
            executable(path / 'git', '''if [ "$1" = rev-parse ]; then echo "$TARGET_SHA"; fi
''')
            executable(path / 'docker', '''printf '%s\n' "$*" >> "$CALLS"
case "$1" in
  image)
    if [ "$MODE" = missing-image ]; then exit 19; fi
    case "${@: -1}" in *assetflow-api:*) echo sha256:api-release ;; *) echo sha256:web-release ;; esac ;;
  compose)
    case "$*" in
      *'up -d'*)
        cat > "$WEB_STDIN"
        [ "$MODE" != activation-fails ] || exit 17
        if [ "$MODE" != stale-web ]; then touch "$ACTIVATED"; fi ;;
      *'ps -q api')
        [ "$MODE" = missing-container ] || echo api-container ;;
      *'ps -q nginx') echo nginx-container ;;
    esac ;;
  inspect)
    if [ "${@: -1}" = api-container ]; then
      if [ "$MODE" = stale-api ]; then echo sha256:old-api; else echo sha256:api-release; fi
    elif [ -f "$ACTIVATED" ]; then echo sha256:web-release
    else echo sha256:old-web
    fi ;;
esac
''')
            # Force mktemp into this private fixture to verify cleanup too.
            temporary = path / 'temporary'
            temporary.mkdir()
            env = {**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}',
                   'HOST': 'invalid.test', 'USER': 'test', 'CONFIGURED_PATH': str(repo),
                   'IMAGE': API, 'MIGRATE_IMAGE': MIGRATE, 'WEB_IMAGE': WEB,
                   'XDG_STATE_HOME': str(path / 'state'), 'TMPDIR': str(temporary),
                   'OUT_FILE': str(path / 'out'), 'TARGET_SHA': SHA, 'MODE': mode,
                   'DRAINED': str(path / 'drained'), 'WEB_STDIN': str(path / 'web-stdin'),
                   'ACTIVATED': str(path / 'activated'), 'CALLS': str(path / 'calls')}
            run = RUN.replace('out=/tmp/deploy-remote.log', 'out="$OUT_FILE"')
            result = subprocess.run(['bash', '-e', '-c', run], env=env, text=True,
                                    capture_output=True, timeout=5)
            return {
                'result': result,
                'drained': (path / 'drained').read_text(),
                'activated': (path / 'activated').exists(),
                'web_stdin': (path / 'web-stdin').read_text() if (path / 'web-stdin').exists() else None,
                'temporary_files': list(temporary.iterdir()),
            }

    def test_plain_bash_s_can_silently_lose_remaining_commands(self):
        # Minimal reproduction of the old transport, using real Bash and cat.
        result = subprocess.run(['bash', '-s'], input='echo BEFORE\ncat >/dev/null\necho AFTER\n',
                                text=True, capture_output=True, timeout=3)
        self.assertEqual(result.returncode, 0)
        self.assertIn('BEFORE', result.stdout)
        self.assertNotIn('AFTER', result.stdout)

    def test_stdin_reading_children_cannot_skip_web_activation_and_verification(self):
        outcome = self.run_remote()
        result = outcome['result']
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(outcome['drained'], '')
        self.assertEqual(outcome['web_stdin'], '')
        self.assertTrue(outcome['activated'])
        self.assertIn('verified api image sha256:api-release', result.stdout)
        self.assertIn('verified nginx image sha256:web-release', result.stdout)
        self.assertIn(f'ASSETFLOW_DEPLOY_COMPLETE {SHA}', result.stdout)
        self.assertEqual(outcome['temporary_files'], [])

    def test_stale_api_or_web_cannot_pass_with_successful_commands(self):
        for mode, service in [('stale-api', 'api'), ('stale-web', 'nginx')]:
            with self.subTest(mode=mode):
                outcome = self.run_remote(mode)
                result = outcome['result']
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'release verification failed for {service}', result.stdout)
                self.assertNotIn(f'ASSETFLOW_DEPLOY_COMPLETE {SHA}', result.stdout)
                self.assertEqual(outcome['temporary_files'], [])

    def test_deploy_activation_and_inspection_errors_remain_failures(self):
        for mode in ['deploy-fails', 'activation-fails', 'missing-image', 'missing-container']:
            with self.subTest(mode=mode):
                outcome = self.run_remote(mode)
                result = outcome['result']
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(f'ASSETFLOW_DEPLOY_COMPLETE {SHA}', result.stdout)
                self.assertEqual(outcome['temporary_files'], [])
                if mode == 'deploy-fails':
                    self.assertFalse(outcome['activated'])

    @unittest.skipUnless(shutil.which('docker'), 'Docker unavailable; real-Compose test runs in infra CI')
    def test_real_compose_exec_without_tty_cannot_consume_script_payload(self):
        docker = shutil.which('docker')
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            definition = path / 'compose.yml'
            definition.write_text('services:\n  reader:\n    image: alpine:3.21\n    command: ["sleep", "600"]\n')
            compose = [docker, 'compose', '-p', 'assetflow-stdin-' + path.name.replace('_', ''), '-f', str(definition)]
            try:
                subprocess.run(compose + ['up', '-d', '--wait', '--wait-timeout', '30'], check=True,
                               capture_output=True, text=True, timeout=90)
                # Pass Compose args as positional parameters, not interpolated
                # shell source; stdout demonstrates that cat reached EOF.
                payload = '"$@" exec -T reader cat\nprintf "AFTER_REAL_COMPOSE\\n"\n'
                result = subprocess.run(['bash', '-c', bootstrap(), '--', *compose], input=payload,
                                        text=True, capture_output=True, timeout=20)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('AFTER_REAL_COMPOSE', result.stdout)
                self.assertNotIn('printf', result.stdout, 'script lines leaked to container stdin')
            finally:
                subprocess.run(compose + ['down', '--timeout', '2'], check=True,
                               capture_output=True, text=True, timeout=30)


if __name__ == '__main__':
    unittest.main()
