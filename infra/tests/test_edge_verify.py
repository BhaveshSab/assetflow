"""The edge must be proven to serve the pinned release, not merely "answer"."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'infra/scripts/verify-edge.sh'
EXPECTED = 'ghcr.io/example/web:' + 'b' * 40

DOCKER_STUB = '''#!/usr/bin/env bash
case "$1" in
  ps) [ "${CONTAINER_PRESENT:-1}" = 1 ] && echo cid123; exit 0 ;;
  inspect) printf '%s\\n' "${RUNNING_IMAGE:-$EXPECTED_IMAGE}"; exit 0 ;;
  exec) [ "${ASSET_PRESENT:-1}" = 1 ] && exit 0 || exit 1 ;;
  *) exit 99 ;;
esac
'''

CURL_STUB = '''#!/usr/bin/env bash
case "$*" in
  *health/ready*) printf '%s' "${READY_CODE:-200}" ;;
  *https://127.0.0.1/*)
    [ "${HTML_FAIL:-0}" = 1 ] && exit 22
    printf '%s' "${HTML_BODY:-<script src=\\"/assets/index-abc123.js\\"></script>}" ;;
  *) exit 99 ;;
esac
'''


class EdgeVerifyScriptTests(unittest.TestCase):
    def run_script(self, args=(EXPECTED,), **env_overrides):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for name, body in (('docker', DOCKER_STUB), ('curl', CURL_STUB)):
                stub = path / name
                stub.write_text(body)
                stub.chmod(0o755)
            env = {**os.environ, 'PATH': f'{path}:{os.environ["PATH"]}',
                   'EXPECTED_IMAGE': EXPECTED, **env_overrides}
            return subprocess.run(['bash', str(SCRIPT), *args], env=env,
                                  text=True, capture_output=True)

    def test_matching_edge_passes(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('edge OK', result.stdout)

    def test_stale_edge_image_fails_and_names_both_refs(self):
        result = self.run_script(RUNNING_IMAGE='ghcr.io/example/web:latest')
        self.assertEqual(result.returncode, 1)
        self.assertIn('ghcr.io/example/web:latest', result.stderr)
        self.assertIn(EXPECTED, result.stderr)

    def test_missing_edge_container_fails(self):
        result = self.run_script(CONTAINER_PRESENT='0')
        self.assertEqual(result.returncode, 1)
        self.assertIn('no running nginx container', result.stderr)

    def test_served_asset_missing_from_image_fails(self):
        result = self.run_script(ASSET_PRESENT='0')
        self.assertEqual(result.returncode, 1)
        self.assertIn('/assets/index-abc123.js', result.stderr)
        self.assertIn('not inside', result.stderr)

    def test_unready_api_fails(self):
        result = self.run_script(READY_CODE='503')
        self.assertEqual(result.returncode, 1)
        self.assertIn('503', result.stderr)

    def test_unreachable_loopback_https_fails(self):
        result = self.run_script(HTML_FAIL='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('loopback HTTPS', result.stderr)

    def test_page_without_a_built_asset_fails(self):
        result = self.run_script(HTML_BODY='<html>no bundle</html>')
        self.assertEqual(result.returncode, 1)
        self.assertIn('no built index asset', result.stderr)

    def test_missing_argument_is_a_usage_error(self):
        result = self.run_script(args=())
        self.assertEqual(result.returncode, 2)
        self.assertIn('usage:', result.stderr)


class DeployWorkflowEdgeTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load((ROOT / '.github/workflows/deploy.yml').read_text())
        self.steps = self.workflow['jobs']['deploy']['steps']
        self.by_name = {s.get('name'): s for s in self.steps}

    def test_edge_is_force_recreated_from_the_pinned_image(self):
        run = self.by_name['Deploy']['run']
        activation = next(line for line in run.splitlines() if 'up -d --no-deps' in line and 'nginx' in line)
        self.assertIn('--force-recreate', activation)
        self.assertIn('--pull never', activation)
        self.assertIn('|| exit 7', activation)

    def test_verify_runs_the_edge_script_against_the_pinned_web_image(self):
        step = self.by_name['Verify the deployment on the host']
        self.assertIn('infra/scripts/verify-edge.sh', step['run'])
        self.assertEqual(step['env']['WEB_IMAGE'],
                         '${{ steps.image.outputs.web }}:${{ github.sha }}')

    def test_verify_no_longer_accepts_readiness_as_proof_of_deploy(self):
        run = self.by_name['Verify the deployment on the host']['run']
        self.assertNotIn('the API is healthy', run)
        self.assertIn('verify-edge.sh failed after bounded retries', run)


if __name__ == '__main__':
    unittest.main()
