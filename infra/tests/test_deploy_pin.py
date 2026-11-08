"""Exercise the remote checkout guard with stub git, never touching a server."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
TARGET = 'b' * 40


class DeployCommitPinTests(unittest.TestCase):
    def run_guard(self, mode='forward', image=None):
        workflow = yaml.safe_load((ROOT / '.github/workflows/deploy.yml').read_text())
        run = next(s['run'] for s in workflow['jobs']['deploy']['steps'] if s.get('name') == 'Deploy')
        fragment = run[run.index('target_commit="${image##*:}"'):run.index('chmod +x')]
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            head = path / 'head'
            head.write_text('c' * 40 if mode == 'newer' else 'a' * 40)
            stub = path / 'git'
            stub.write_text('''#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
  diff) [ "$MODE" != dirty ] ;;
  fetch) [ "$MODE" != fetch-fails ] ;;
  merge)
    [ "$MODE" != divergent ] || exit 1
    if [ "$MODE" != newer ]; then printf '%s' "$3" > "$HEAD_FILE"; fi ;;
  rev-parse) cat "$HEAD_FILE" ;;
  log|status) echo 'inspection only' ;;
  *) exit 99 ;;
esac
''')
            stub.chmod(0o755)
            calls = path / 'calls'
            env = {**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}', 'MODE': mode,
                   'CALLS': str(calls), 'HEAD_FILE': str(head), 'image': image or f'ghcr.io/example/api:{TARGET}'}
            result = subprocess.run(['bash', '-uc', fragment], env=env, text=True, capture_output=True)
            return result, calls.read_text() if calls.exists() else '', head.read_text()

    def test_fast_forward_uses_exact_image_sha_not_main(self):
        result, calls, head = self.run_guard()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f'fetch origin {TARGET}', calls)
        self.assertIn(f'merge --ff-only {TARGET}', calls)
        self.assertEqual(head, TARGET)
        self.assertNotIn('pull', calls)
        self.assertNotIn('reset', calls)

    def test_newer_checkout_is_not_silently_used_with_old_image(self):
        result, _, head = self.run_guard('newer')
        self.assertEqual(result.returncode, 4)
        self.assertIn('refusing to mix code and image', result.stdout)
        self.assertEqual(head, 'c' * 40)

    def test_dirty_checkout_is_preserved(self):
        result, calls, head = self.run_guard('dirty')
        self.assertEqual(result.returncode, 4)
        self.assertNotIn('fetch', calls)
        self.assertEqual(head, 'a' * 40)

    def test_divergence_and_fetch_failure_are_errors(self):
        for mode in ['divergent', 'fetch-fails']:
            with self.subTest(mode=mode):
                result, _, _ = self.run_guard(mode)
                self.assertEqual(result.returncode, 4)

    def test_mutable_image_tag_is_rejected_before_git(self):
        result, calls, _ = self.run_guard(image='ghcr.io/example/api:latest')
        self.assertEqual(result.returncode, 4)
        self.assertEqual(calls, '')


if __name__ == '__main__':
    unittest.main()
