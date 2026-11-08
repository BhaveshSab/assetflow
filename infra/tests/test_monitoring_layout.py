"""Guard the integration boundaries that the late merge broke."""
from pathlib import Path
import re
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[2]
PROM = ROOT / 'infra/prometheus'


class MonitoringLayoutTests(unittest.TestCase):
    def test_production_glob_contains_only_rules_and_all_alerts_have_tests(self):
        alerts = set()
        groups = []
        for path in (PROM / 'rules').glob('*.yml'):
            data = yaml.safe_load(path.read_text())
            self.assertIn('groups', data, f'{path}: test fixtures must not be in production rules/')
            self.assertNotIn('tests', data)
            for group in data['groups']:
                groups.append(group['name'])
                alerts.update(r['alert'] for r in group['rules'] if 'alert' in r)
        self.assertEqual(len(groups), len(set(groups)))
        covered = set()
        for path in (PROM / 'tests').glob('*.yml'):
            data = yaml.safe_load(path.read_text())
            for group in data['tests']:
                covered.update(t['alertname'] for t in group.get('alert_rule_test', []))
                for test in group.get('promql_expr_test', []):
                    covered.update(re.findall(r'alertname="([A-Za-z0-9_]+)"', test['expr']))
        self.assertTrue(alerts)
        self.assertEqual(alerts - covered, set(), 'Every production alert needs a test')

    def test_public_probe_and_optional_worker_jobs_survive_merge(self):
        compose = yaml.safe_load((ROOT / 'infra/docker-compose.yml').read_text())
        config = yaml.safe_load((PROM / 'prometheus.yml').read_text())
        jobs = {j['job_name']: j for j in config['scrape_configs']}
        self.assertEqual(len(jobs), len(config['scrape_configs']))
        self.assertTrue({'cadvisor', 'blackbox-https', 'assetflow-jobs'} <= jobs.keys())
        replacements = [r['replacement'] for r in jobs['blackbox-https']['relabel_configs'] if 'replacement' in r]
        self.assertEqual(replacements, ['blackbox:9115'])
        self.assertIn('blackbox', compose['services'])
        self.assertNotIn('blackbox-exporter', compose['services'])
        self.assertEqual(config['rule_files'], ['/etc/prometheus/rules/*.yml'])
        self.assertIn('./prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro', compose['services']['prometheus']['volumes'])

    def test_https_checks_certificate_trust_and_requires_tls(self):
        config = yaml.safe_load((ROOT / 'infra/blackbox/blackbox.yml').read_text())
        http = config['modules']['https_2xx']['http']
        self.assertIs(http['tls_config']['insecure_skip_verify'], False)
        self.assertIs(http['fail_if_not_ssl'], True)


if __name__ == '__main__':
    unittest.main()
