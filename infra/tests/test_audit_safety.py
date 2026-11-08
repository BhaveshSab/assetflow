"""Executable offline regressions; never use real Docker, SSH or AWS here."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'infra/scripts'


def load(name):
    path = SCRIPTS / 'lib' / name
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def executable(path, body):
    path.write_text('#!/usr/bin/env bash\nset -eu\n' + body)
    path.chmod(0o755)


class OriginTests(unittest.TestCase):
    def test_rejects_userinfo_and_ambiguous_numeric_hosts(self):
        validate = load('validate-load-origin.py').validate
        for origin in ('https://operator@13.55.90.25', 'https://user:pass@staging.example',
                       'https://0x0d.0x37.0x5a.0x19', 'http://2130706433',
                       'http://0177.0.0.1', 'http://staging.example/path',
                       'http://staging.example?x=y', 'http://staging.example#x',
                       'http://staging.example:99999', 'http://a%2eb.example',
                       'http://a\\@b.example', 'file:///tmp/a'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                validate(origin)

    def test_canonicalizes_ordinary_origins(self):
        validate = load('validate-load-origin.py').validate
        self.assertEqual(validate('HTTPS://STAGING.EXAMPLE.:443/'), 'https://staging.example:443')
        self.assertEqual(validate('http://127.0.0.1:8080'), 'http://127.0.0.1:8080')

    def test_real_load_cannot_start_even_with_legacy_override(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)
            for name in ('docker', 'curl', 'k6', 'aws'):
                executable(p / name, 'echo unexpected > "$CALLED"; exit 90\n')
            result = subprocess.run(['bash', str(SCRIPTS / 'load-test.sh')], capture_output=True, text=True,
                env={**os.environ, 'BASE_URL': 'http://staging.example', 'ALLOW_PRODUCTION_LOAD_TEST': 'yes',
                     'PATH': f'{p}:{os.environ["PATH"]}', 'CALLED': str(p / 'called'), 'LOG_FILE': '/dev/null'})
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('load execution disabled', result.stderr)
            self.assertFalse((p / 'called').exists())


class ChecksumTests(unittest.TestCase):
    def test_only_the_exact_dump_can_be_verified(self):
        verify = load('verify-backup-checksum.py').verify
        with tempfile.TemporaryDirectory() as folder:
            dump = Path(folder) / 'fixture.dump'
            dump.write_bytes(b'correct')
            checksum = Path(str(dump) + '.sha256')
            digest = hashlib.sha256(dump.read_bytes()).hexdigest()
            checksum.write_text(f'{digest}  {dump.name}\n')
            verify(dump)
            for name in ('other.dump', '../fixture.dump', str(dump)):
                checksum.write_text(f'{digest}  {name}\n')
                with self.subTest(name=name), self.assertRaises(ValueError):
                    verify(dump)
            checksum.write_text(f'{digest}  {dump.name}\n{digest}  other.dump\n')
            with self.assertRaises(ValueError):
                verify(dump)
            checksum.write_text(f'{digest}  {dump.name}\n')
            dump.write_bytes(b'corrupt')
            with self.assertRaises(ValueError):
                verify(dump)


class HistoryTests(unittest.TestCase):
    def test_sql_matches_names_checksums_and_successful_state(self):
        sql = load('restore-history.py').history_sql(ROOT / 'backend/prisma/migrations')
        self.assertIn('rolled_back_at IS NULL', sql)
        self.assertIn('finished_at IS NULL', sql)
        self.assertIn('HAVING count(*) <> 1', sql)
        for path in (ROOT / 'backend/prisma/migrations').glob('*/migration.sql'):
            self.assertIn(path.parent.name, sql)
            self.assertIn(hashlib.sha256(path.read_bytes()).hexdigest(), sql)

    def test_missing_history_fails_closed(self):
        with tempfile.TemporaryDirectory() as folder, self.assertRaises(ValueError):
            load('restore-history.py').history_sql(folder)

    def test_migrate_precedes_current_table_checks_and_no_ports(self):
        body = (SCRIPTS / 'restore-verify.sh').read_text()
        self.assertLess(body.index('migration_exit='), body.index('EXPECTED_TABLES='))
        self.assertNotIn('compose exec', body)
        self.assertNotIn('MIGRATE_PORT', body)
        self.assertNotIn('-p "', body)
        self.assertIn('network create --internal', body)
        self.assertIn('RESTORE_MIGRATE_IMAGE must have a full release-SHA tag', body)
        self.assertIn('indisvalid', (SCRIPTS / 'lib/restore-constraints.sql').read_text())


class RestoreCleanupTests(unittest.TestCase):
    def test_failed_checksum_download_removes_private_temporary_dump(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)
            downloads = p / 'downloads'
            downloads.mkdir()
            manifest = subprocess.check_output(['bash', '-c',
                'sha256sum schema.prisma; find migrations -type f -print0 | sort -z | xargs -0 sha256sum'],
                cwd=ROOT / 'backend/prisma', text=True)
            (p / 'manifest').write_text(manifest)
            executable(p / 'docker', '''case "$1" in
  image) printf 'sha256:%064d\\n' 1 ;;
  run) cat "$MANIFEST" ;;
  *) echo unexpected > "$CALLED"; exit 90 ;;
esac
''')
            executable(p / 'aws', '''case "$*" in
  *sha256*) exit 42 ;;
  *) printf 'offline dummy dump' > "$4" ;;
esac
''')
            sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
            result = subprocess.run(['bash', str(SCRIPTS / 'restore-verify.sh'), '--from-s3',
                                    's3://offline-fixture/fixture.dump'], text=True, capture_output=True,
                env={**os.environ, 'PATH': f'{p}:{os.environ["PATH"]}', 'TMPDIR': str(downloads),
                     'LOG_FILE': '/dev/null', 'S3_BUCKET': 'offline-fixture', 'MANIFEST': str(p / 'manifest'),
                     'CALLED': str(p / 'called'), 'RESTORE_MIGRATE_IMAGE': f'ghcr.io/example/migrate:{sha}'})
            self.assertEqual(result.returncode, 42, result.stderr)
            self.assertEqual(list(downloads.iterdir()), [])
            self.assertFalse((p / 'called').exists(), 'no Docker resources should have been created')


class DrillGateTests(unittest.TestCase):
    def test_legacy_override_cannot_enable_destructive_phases(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)
            executable(p / 'aws', 'echo unexpected > "$CALLED"; exit 90\n')
            for phase in ('teardown', 'rebuild', 'all'):
                result = subprocess.run(['bash', str(SCRIPTS / 'rebuild-drill.sh'), '--phase', phase],
                    text=True, capture_output=True, env={**os.environ, 'LOG_FILE': '/dev/null',
                        'PATH': f'{p}:{os.environ["PATH"]}', 'CALLED': str(p / 'called'),
                        'DRILL_UPLOAD_ENV_TO_S3': 'yes'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('rebuild execution disabled', result.stderr)
            self.assertFalse((p / 'called').exists())

    def test_dry_run_does_not_create_log_files(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / 'must-not-exist'
            result = subprocess.run(['bash', str(SCRIPTS / 'restore-verify.sh'), '--dry-run'],
                text=True, capture_output=True, env={**os.environ, 'LOG_DIR': str(p), 'LOG_FILE': ''})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(p.exists())

class VerificationTransportTests(unittest.TestCase):
    def test_spooled_transport_and_marker_fail_closed(self):
        import yaml
        from test_edge_verify import DOCKER_STUB, CURL_STUB, EXPECTED
        workflow = yaml.safe_load((ROOT / '.github/workflows/deploy.yml').read_text())
        run = next(s['run'] for s in workflow['jobs']['deploy']['steps']
                   if s.get('name') == 'Verify the deployment on the host')
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)
            for name, body in [('docker', DOCKER_STUB), ('curl', CURL_STUB)]:
                (p / name).write_text(body)
                (p / name).chmod(0o755)
            executable(p / 'sleep', 'exit 0\n')
            executable(p / 'ssh', '''case "$MODE" in
 execute) exec bash -c "${@: -1}" ;;
 absent) cat >/dev/null; exit 0 ;;
 wrong) cat >/dev/null; echo 'ASSETFLOW_EDGE_VERIFIED wrong-image'; exit 0 ;;
 nonzero) cat >/dev/null; echo "ASSETFLOW_EDGE_VERIFIED $WEB_IMAGE"; exit 23 ;;
esac
''')
            for mode, ready, code in [('execute', '200', 0), ('execute', '503', 1),
                                      ('absent', '200', 1), ('wrong', '200', 1),
                                      ('nonzero', '200', 1)]:
                with self.subTest(mode=mode, ready=ready):
                    result = subprocess.run(['bash', '-e', '-c', run], cwd=ROOT, capture_output=True,
                        text=True, timeout=20, env={**os.environ, 'PATH': f'{p}:{os.environ["PATH"]}',
                        'MODE': mode, 'READY_CODE': ready, 'READ_STDIN': '1', 'EXPECTED_IMAGE': EXPECTED,
                        'WEB_IMAGE': EXPECTED, 'VERIFY_HOST': 'https://example.test',
                        'HOST': 'offline.invalid', 'USER': 'offline'})
                    self.assertEqual(result.returncode, code, result.stdout + result.stderr)


class BackupExecutionTests(unittest.TestCase):
    def run_backup(self, mode):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)
            backups = p / 'backups'
            backups.mkdir()
            old = backups / 'assetflow-old.dump'
            old.write_bytes(b'old backup')
            os.utime(old, (1, 1))
            executable(p / 'docker', '''case "$*" in
 'compose version') exit 0 ;;
 *pg_dump*) printf 'offline fixture backup'; exit 0 ;;
 *) exit 99 ;;
esac
''')
            executable(p / 'aws', '''case "$*" in
 *'s3 ls'*) [ "$MODE" != empty ] && echo 'object exists'; exit 0 ;;
 *' - --only-show-errors')
   object="$(basename "$3")"
   if [ "$MODE" = corrupt ]; then echo corrupt; else cat "$BACKUP_DIR/$object"; fi ;;
 *) [ "$MODE" != failed ] || exit 42 ;;
esac
''')
            result = subprocess.run(['bash', str(SCRIPTS / 'backup.sh')], capture_output=True, text=True,
                env={**os.environ, 'PATH': f'{p}:{os.environ["PATH"]}', 'MODE': mode,
                     'LOG_FILE': '/dev/null', 'BACKUP_DIR': str(backups), 'RETENTION_DAYS': '14',
                     'TEXTFILE_DIR': str(p / 'metrics'), 'S3_BUCKET': '' if mode == 'local' else 'offline-bucket',
                     'S3_PREFIX': 'backups', 'POSTGRES_PASSWORD': 'offline-fixture-only'})
            return result, old.exists(), (p / 'metrics/assetflow_backup_last_success_timestamp_seconds.prom').exists()

    def test_failed_empty_and_corrupt_uploads_keep_local_history(self):
        for mode in ('failed', 'empty', 'corrupt'):
            with self.subTest(mode=mode):
                result, old_exists, metric = self.run_backup(mode)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertTrue(old_exists)
                self.assertFalse(metric)

    def test_matching_remote_bytes_allow_retention_and_success_metric(self):
        result, old_exists, metric = self.run_backup('matching')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(old_exists)
        self.assertTrue(metric)

    def test_local_only_does_not_claim_off_host_success(self):
        result, old_exists, metric = self.run_backup('local')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(old_exists)
        self.assertFalse(metric)


class RestoreFlowTests(unittest.TestCase):
    """Model orchestration and failures, not real PostgreSQL correctness."""
    def test_isolated_flow_and_failures(self):
        for mode in ('success', 'migration-fail', 'db-create-fail', 'constraints-fail'):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                p = Path(folder)
                dump = p / 'fixture.dump'
                dump.write_bytes(b'offline fixture')
                Path(str(dump) + '.sha256').write_text(
                    hashlib.sha256(dump.read_bytes()).hexdigest() + '  fixture.dump\n')
                manifest = subprocess.check_output(['bash', '-c',
                    'sha256sum schema.prisma; find migrations -type f -print0 | sort -z | xargs -0 sha256sum'],
                    cwd=ROOT / 'backend/prisma', text=True)
                (p / 'manifest').write_text(manifest)
                executable(p / 'docker', r'''printf '%s\n' "$*" >> "$CALLS"
case "$1" in
 image) printf 'sha256:%064d\n' 1 ;;
 run) cat "$MANIFEST" ;;
 network|volume|start|stop|rm|cp) exit 0 ;;
 create)
   if [[ "$*" == *--network-alias* ]] && [ "$MODE" = db-create-fail ]; then exit 71; fi ;;
 wait)
   [ "$MODE" != migration-fail ] || { echo 1; exit 0; }
   touch "$MIGRATED"; echo 0 ;;
 exec)
   case "$*" in
     *pg_isready*|*pg_restore*) exit 0 ;;
     *'select to_regclass'*) [ -f "$MIGRATED" ] || exit 72; echo t ;;
     *'SELECT count('*'"User"'*) echo 1 ;;
     *'SELECT count('*) echo 0 ;;
     *'count(*) > 0'*) echo true ;;
     *'select count('* ) echo 0 ;;
     *'-tA')
       sql=$(cat)
       if [[ "$sql" == *pg_index* ]] && [ "$MODE" = constraints-fail ]; then echo f; else echo t; fi ;;
     *) exit 73 ;;
   esac ;;
 *) exit 74 ;;
esac
''')
                sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
                result = subprocess.run(['bash', str(SCRIPTS / 'restore-verify.sh'), '--from', str(dump)],
                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=15,
                    env={**os.environ, 'PATH': f'{p}:{os.environ["PATH"]}', 'LOG_FILE': '/dev/null',
                        'CALLS': str(p / 'calls'), 'MANIFEST': str(p / 'manifest'), 'MODE': mode,
                        'MIGRATED': str(p / 'migrated'), 'TMPDIR': str(p), 'TEXTFILE_DIR': str(p / 'metrics'),
                        'RESTORE_MIGRATE_IMAGE': f'ghcr.io/example/migrate:{sha}'})
                calls = (p / 'calls').read_text()
                self.assertNotIn('compose', calls)
                self.assertNotIn(' -p ', calls)
                self.assertIn('network rm ', calls)
                self.assertIn('volume rm ', calls)
                self.assertEqual(result.returncode == 0, mode == 'success', result.stdout + result.stderr)
                self.assertEqual((p / 'metrics/assetflow_restore_verify_last_success_timestamp_seconds.prom').exists(),
                                 mode == 'success')
                if mode == 'db-create-fail':
                    self.assertNotIn('rm -f assetflow-restore-verify-', calls)


if __name__ == '__main__':
    unittest.main()
