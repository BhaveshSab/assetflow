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

DOCKER_STUB = r'''#!/usr/bin/env bash
html_default='<script src="/assets/index-abc123.js"></script>'
case "$1" in
  ps) [ "${CONTAINER_PRESENT:-1}" = 1 ] && printf '%s\n' "${CONTAINERS:-cid123}"; exit 0 ;;
  image) printf '%s\n' 'sha256:expected'; exit 0 ;;
  inspect)
    case "$*" in
      *'.Config.Image'*) printf '%s\n' "${RUNNING_IMAGE:-$EXPECTED_IMAGE}" ;;
      *) printf '%s\n' "${RUNNING_ID:-sha256:expected}" ;;
    esac; exit 0 ;;
  exec)
    [ "${READ_STDIN:-0}" != 1 ] || cat >/dev/null
    case "$*" in
      *' test -f '*) [ "${ASSET_PRESENT:-1}" = 1 ] ;;
      *' cat '*) printf '%s' "${IMAGE_HTML_BODY:-${HTML_BODY:-$html_default}}" ;;
      *' sha256sum '*) printf '%s' 'bundle-bytes' | sha256sum ;;
      *) exit 99 ;;
    esac; exit $? ;;
  *) exit 99 ;;
esac
'''

CURL_STUB = r'''#!/usr/bin/env bash
html_default='<script src="/assets/index-abc123.js"></script>'
case "$*" in
  *health/ready*) printf '%s' "${READY_CODE:-200}" ;;
  *https://127.0.0.1/assets/*) printf '%s' "${ASSET_BYTES:-bundle-bytes}" ;;
  *https://127.0.0.1/*)
    [ "${HTML_FAIL:-0}" = 1 ] && exit 22
    printf '%s' "${HTML_BODY:-$html_default}" ;;
  *) [ "${TLS_FAIL:-0}" = 1 ] && exit 60; exit 0 ;;
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
        self.assertIn('ASSETFLOW_EDGE_VERIFIED', result.stdout)

    def test_success_prints_the_completion_marker_last(self):
        result = self.run_script()
        lines = [line for line in result.stdout.strip().splitlines() if line]
        self.assertEqual(lines[-1], f'ASSETFLOW_EDGE_VERIFIED {EXPECTED}')

    def test_stale_edge_image_fails_and_names_both_refs(self):
        result = self.run_script(RUNNING_IMAGE='ghcr.io/example/web:latest')
        self.assertEqual(result.returncode, 1)
        self.assertIn('ghcr.io/example/web:latest', result.stderr)
        self.assertIn(EXPECTED, result.stderr)
        self.assertNotIn('ASSETFLOW_EDGE_VERIFIED', result.stdout)

    def test_missing_edge_container_fails(self):
        result = self.run_script(CONTAINER_PRESENT='0')
        self.assertEqual(result.returncode, 1)
        self.assertIn('no running nginx container', result.stderr)

    def test_served_asset_missing_from_image_fails(self):
        result = self.run_script(ASSET_PRESENT='0')
        self.assertEqual(result.returncode, 1)
        self.assertIn('/assets/index-abc123.js', result.stderr)
        self.assertIn('not inside', result.stderr)

    def test_unready_api_fails_and_never_prints_the_marker(self):
        result = self.run_script(READY_CODE='503')
        self.assertEqual(result.returncode, 1)
        self.assertIn('503', result.stderr)
        self.assertNotIn('ASSETFLOW_EDGE_VERIFIED', result.stdout)

    def test_unreachable_loopback_https_fails(self):
        result = self.run_script(HTML_FAIL='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('loopback HTTPS', result.stderr)

    def test_page_without_a_built_asset_fails(self):
        result = self.run_script(HTML_BODY='<html>no bundle</html>')
        self.assertEqual(result.returncode, 1)
        self.assertIn('no built index asset', result.stderr)

    def test_wrong_actual_image_id_is_rejected(self):
        self.assertNotEqual(self.run_script(RUNNING_ID='sha256:stale').returncode, 0)

    def test_multiple_edges_are_rejected(self):
        self.assertNotEqual(self.run_script(CONTAINERS='cid1\ncid2').returncode, 0)

    def test_served_html_bytes_must_match_image(self):
        self.assertNotEqual(self.run_script(IMAGE_HTML_BODY='old build').returncode, 0)

    def test_served_asset_bytes_must_match_image(self):
        self.assertNotEqual(self.run_script(ASSET_BYTES='stale bundle').returncode, 0)

    def test_reading_child_cannot_skip_failed_readiness(self):
        result = self.run_script(READ_STDIN='1', READY_CODE='503')
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('ASSETFLOW_EDGE_VERIFIED', result.stdout)

    def test_missing_argument_is_a_usage_error(self):
        result = self.run_script(args=())
        self.assertEqual(result.returncode, 2)
        self.assertIn('usage:', result.stderr)

    def test_tls_is_verified_against_the_named_host(self):
        result = self.run_script(args=(EXPECTED, 'https://example.test'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('TLS verified against https://example.test', result.stdout)

    def test_a_failing_tls_check_fails_the_whole_verification(self):
        result = self.run_script(args=(EXPECTED, 'https://example.test'), TLS_FAIL='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('verified TLS', result.stderr)

    def test_without_a_named_host_it_says_tls_was_not_checked(self):
        result = self.run_script()
        self.assertIn('TLS to the public name not checked', result.stdout)


class DeployWorkflowEdgeTests(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.safe_load((ROOT / '.github/workflows/deploy.yml').read_text())
        self.steps = self.workflow['jobs']['deploy']['steps']
        self.by_name = {s.get('name'): s for s in self.steps}
        self.verify_run = self.by_name['Verify the deployment on the host']['run']
        self.deploy_run = self.by_name['Deploy']['run']

    def test_edge_is_force_recreated_from_the_pinned_image(self):
        run = self.deploy_run
        activation = next(line for line in run.splitlines()
                          if 'up -d --no-deps' in line and 'nginx' in line)
        self.assertIn('--force-recreate', activation)
        self.assertIn('--pull never', activation)
        self.assertIn('|| exit 7', activation)

    def test_verify_runs_the_edge_script_against_the_pinned_web_image(self):
        step = self.by_name['Verify the deployment on the host']
        self.assertIn('infra/scripts/verify-edge.sh', step['run'])
        self.assertEqual(step['env']['WEB_IMAGE'],
                         '${{ steps.image.outputs.web }}:${{ github.sha }}')

    def test_verify_no_longer_accepts_readiness_as_proof_of_deploy(self):
        self.assertNotIn('the API is healthy', self.verify_run)
        self.assertIn('Edge is not serving the deployed build', self.verify_run)

    # --- the false-success defect found in review -------------------------

    def test_the_script_is_spooled_on_the_remote_not_piped_to_bash_s(self):
        # `bash -s` shares the command stream with every child's stdin, so a
        # greedy child can swallow the rest of the script and return 0.
        self.assertIn('remote_bootstrap', self.verify_run)
        self.assertIn('cat > "$script"', self.verify_run)
        self.assertIn('bash "$script" "$@" </dev/null', self.verify_run)
        self.assertNotIn('bash -s --', self.verify_run)

    def test_success_requires_the_literal_completion_marker(self):
        # An exit 0 alone is not proof: the marker is asserted, and it is
        # asserted before the success path is taken.
        self.assertIn('ASSETFLOW_EDGE_VERIFIED ${WEB_IMAGE}', self.verify_run)
        self.assertIn('grep -Fxq', self.verify_run)
        self.assertLess(self.verify_run.index('grep -Fxq'),
                        self.verify_run.index('the live edge is serving'))

    def test_a_zero_exit_without_the_marker_does_not_succeed(self):
        self.assertIn('::warning title=Edge check did not confirm', self.verify_run)


class RestoreVerificationSqlTests(unittest.TestCase):
    """The restore checks must use this schema's vocabulary and Prisma's tools."""

    def setUp(self):
        self.body = (ROOT / 'infra/scripts/restore-verify.sh').read_text() + (ROOT / 'infra/scripts/lib/restore-history.py').read_text() + (ROOT / 'infra/scripts/lib/restore-constraints.sql').read_text()
        self.schema = (ROOT / 'backend/prisma/schema.prisma').read_text()

    def enum_values(self, name):
        block = self.schema.split(f'enum {name} {{')[1].split('}')[0]
        return {token for token in block.split() if token.isupper()}

    def test_booking_statuses_used_exist_in_the_schema_enum(self):
        # The first attempt queried CONFIRMED and ACTIVE as Booking statuses,
        # neither of which this schema has, so the check could only error out.
        valid = self.enum_values('BookingStatus')
        self.assertEqual(valid, {'UPCOMING', 'ONGOING', 'COMPLETED', 'CANCELLED'})
        self.assertNotIn("'CONFIRMED'", self.body)
        # Any Booking-scoped status literal must be in the enum. Allocation and
        # User legitimately use 'ACTIVE' (AllocationStatus, RecordStatus), so the
        # assertion is scoped to lines that mention Booking.
        for line in self.body.splitlines():
            if 'Booking' not in line or 'where' not in line:
                continue
            for status in valid | {'CONFIRMED', 'ACTIVE', 'PENDING'}:
                if f"'{status}'" in line and status not in valid:
                    self.fail(f'{status} is not a BookingStatus: {line.strip()}')

    def test_allocation_statuses_used_exist_in_the_schema_enum(self):
        valid = self.enum_values('AllocationStatus')
        self.assertIn('ACTIVE', valid)

    def test_overlap_rule_is_read_from_the_catalog_not_reimplemented(self):
        self.assertIn('Booking_no_overlap', self.body)
        self.assertIn('pg_constraint', self.body)
        self.assertIn('Allocation_one_active_per_asset', self.body)
        self.assertIn('pg_indexes', self.body)

    def test_migrations_run_through_prisma_not_a_manual_replay(self):
        self.assertIn('prisma migrate deploy', self.body)
        self.assertIn('_prisma_migrations', self.body)
        self.assertNotIn('< "$migration"', self.body)

    def test_the_restore_publishes_no_port_except_loopback_for_migrations(self):
        for line in self.body.splitlines():
            if '-p ' in line and '5432' in line:
                self.assertIn('127.0.0.1:', line, line)

    def test_permissions_checks_cover_every_declared_model(self):
        models = [line.split()[1] for line in self.schema.splitlines()
                  if line.startswith('model ')]
        self.assertTrue(models)
        for model in models:
            self.assertIn(model, self.body, f'{model} is not covered')


if __name__ == '__main__':
    unittest.main()
