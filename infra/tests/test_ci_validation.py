import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('check_yaml', ROOT / 'infra/scripts/check-yaml.py')
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class YamlValidationTests(unittest.TestCase):
    def test_duplicate_cadvisor_service_is_rejected(self):
        with self.assertRaisesRegex(yaml.YAMLError, 'duplicate key: cadvisor'):
            yaml.load('services:\n  cadvisor: {image: first}\n  cadvisor: {image: second}\n', Loader=validation.UniqueKeyLoader)

    def test_valid_aliases_and_explicit_merge_overrides_are_allowed(self):
        doc = yaml.load('defaults: &defaults {restart: always}\nservices:\n  api:\n    <<: *defaults\n    restart: unless-stopped\n', Loader=validation.UniqueKeyLoader)
        self.assertEqual(doc['services']['api']['restart'], 'unless-stopped')

    def test_duplicate_keys_nested_in_a_service_are_rejected(self):
        with self.assertRaisesRegex(yaml.YAMLError, 'duplicate key: image'):
            yaml.load('services:\n  api:\n    image: a\n    image: b\n', Loader=validation.UniqueKeyLoader)


class ComposeDiagnosticsTests(unittest.TestCase):
    def run_check(self, fail):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            docker = path / 'docker'
            docker.write_text('''#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CALLS"
if [ "$FAIL_BASE" = 1 ] && [ "$*" = 'compose -f infra/docker-compose.yml config --quiet' ]; then
  echo 'duplicate service: cadvisor' >&2
  exit 17
fi
exit 0
''')
            docker.chmod(0o755)
            calls = path / 'calls'
            result = subprocess.run(['bash', '-e', str(ROOT / 'infra/scripts/check-compose.sh')],
                env={**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}', 'CALLS': str(calls), 'FAIL_BASE': str(int(fail))},
                text=True, capture_output=True)
            return result, calls.read_text().splitlines()

    def test_failure_is_reported_and_other_variants_still_run_under_errexit(self):
        result, calls = self.run_check(True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('duplicate service: cadvisor', result.stdout)
        self.assertIn('::error title=compose::', result.stdout)
        self.assertIn('exit 17', result.stdout)
        self.assertEqual(len(calls), 4)
        self.assertIn('--profile jobs', calls[-1])

    def test_all_valid_variants_exit_zero(self):
        result, calls = self.run_check(False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(calls), 4)
        self.assertNotIn('::error', result.stdout)


if __name__ == '__main__':
    unittest.main()
