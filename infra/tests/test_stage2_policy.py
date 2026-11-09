"""Contract tests for the Stage 2 execution policy.

This file exists because the policy is a security control: a missing resource
ARN or a dropped condition silently narrows what the run can do, or widens what
it can touch. Each test names the regression it prevents.

Regression history:
  * `ec2:CreateTags` covered only instance/* and volume/*, so tagging the
    network interface at launch would have been denied. `RunInstances` requires
    CreateTags on every tagged resource type, so the omission would have failed
    the launch rather than merely losing a tag.
"""
import json
import re
import unittest
from pathlib import Path

POLICY = Path(__file__).resolve().parents[2] / 'docs/results/capacity-run-stage2-policy.json'
RUN_ID = 'cap-20261109t0800z-a7f3'
PROJECT = 'assetflow-capacity'
REGION = 'ap-southeast-2'
ACCOUNT = '459252806274'

PRODUCTION_INSTANCE = f'arn:aws:ec2:{REGION}:{ACCOUNT}:instance/i-0ff4690ec52d0dc01'
PRODUCTION_VOLUME = f'arn:aws:ec2:{REGION}:{ACCOUNT}:volume/vol-0fec8fdb85d35bfa3'
PRODUCTION_SG = f'arn:aws:ec2:{REGION}:{ACCOUNT}:security-group/sg-088b1c3707a9eb215'


def actions(statement):
    action = statement['Action']
    return action if isinstance(action, list) else [action]


def resources(statement):
    resource = statement['Resource']
    return resource if isinstance(resource, list) else [resource]


class Stage2PolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy = json.loads(POLICY.read_text(encoding='utf-8'))
        cls.statements = cls.policy['Statement']

    # ------------------------------------------------------------ CreateTags
    def test_createtags_covers_instance_volume_and_network_interface(self):
        """Regression: network-interface/* was missing from the CreateTags allow."""
        allows = [s for s in self.statements
                  if s['Effect'] == 'Allow' and 'ec2:CreateTags' in actions(s)]
        self.assertTrue(allows, 'no CreateTags allow statement')
        covered = set()
        for statement in allows:
            for resource in resources(statement):
                for kind in ('instance', 'volume', 'network-interface'):
                    if f':{kind}/*' in resource:
                        covered.add(kind)
        self.assertEqual(
            covered, {'instance', 'volume', 'network-interface'},
            'RunInstances tags every one of these; a missing ARN fails the launch')

    def test_createtags_network_interface_uses_the_same_conditions(self):
        """The added ARN must inherit the region, CreateAction and run tags."""
        allows = [s for s in self.statements
                  if s['Effect'] == 'Allow' and 'ec2:CreateTags' in actions(s)]
        ni = [s for s in allows
              if any('network-interface/*' in r for r in resources(s))]
        self.assertTrue(ni, 'network-interface not covered by CreateTags')
        for statement in ni:
            condition = statement['Condition']['StringEquals']
            self.assertEqual(condition.get('ec2:CreateAction'), 'RunInstances')
            self.assertEqual(condition.get('aws:RequestedRegion'), REGION)
            self.assertEqual(condition.get('aws:RequestTag/RunId'), RUN_ID)
            self.assertEqual(condition.get('aws:RequestTag/Project'), PROJECT)

    def test_every_createtags_allow_is_createaction_constrained(self):
        for statement in self.statements:
            if statement['Effect'] != 'Allow' or 'ec2:CreateTags' not in actions(statement):
                continue
            condition = statement.get('Condition', {}).get('StringEquals', {})
            self.assertIn('ec2:CreateAction', condition, statement['Sid'])

    # ------------------------------------------------- ARN shape constraints
    def test_security_group_arns_never_use_group_names(self):
        for statement in self.statements:
            for resource in resources(statement):
                if 'security-group/' not in resource:
                    continue
                tail = resource.split('security-group/')[1]
                if tail == '*':
                    continue
                self.assertTrue(tail.startswith('sg-'),
                                f"{statement['Sid']} names a group: {tail}")

    def test_no_key_pair_permissions_exist(self):
        # The plan has no SSH, so key-pair management is unnecessary surface.
        allowed = set()
        for statement in self.statements:
            if statement['Effect'] == 'Allow':
                allowed.update(actions(statement))
        key_actions = {a for a in allowed if 'KeyPair' in a}
        self.assertFalse(key_actions, f'unexpected key-pair permissions: {key_actions}')

    # ------------------------------------------------------ production safety
    def test_production_resources_are_denied_for_mutation(self):
        denies = [s for s in self.statements if s['Effect'] == 'Deny']
        denied_targets = set()
        for statement in denies:
            denied_targets.update(resources(statement))
        for target in (PRODUCTION_INSTANCE, PRODUCTION_VOLUME, PRODUCTION_SG):
            self.assertIn(target, denied_targets, f'{target} is not protected by a Deny')

    def test_production_deny_covers_terminate_and_stop(self):
        covering = [s for s in self.statements
                    if s['Effect'] == 'Deny' and PRODUCTION_INSTANCE in resources(s)]
        self.assertTrue(covering)
        denied = set()
        for statement in covering:
            denied.update(actions(statement))
        self.assertIn('ec2:TerminateInstances', denied)
        self.assertIn('ec2:StopInstances', denied)
        self.assertIn('ec2:ModifyInstanceAttribute', denied)

    def test_the_production_deny_wins_over_any_allow(self):
        # A Deny on the production ARN must not be contradicted by an Allow that
        # names the same resource; IAM would still deny, but the policy would be
        # misleading, so assert it directly.
        allowed_targets = set()
        for statement in self.statements:
            if statement['Effect'] == 'Allow':
                allowed_targets.update(resources(statement))
        for target in (PRODUCTION_INSTANCE, PRODUCTION_VOLUME, PRODUCTION_SG):
            self.assertNotIn(target, allowed_targets)

    def test_elastic_ip_cannot_be_released_or_allocated(self):
        denied = set()
        for statement in self.statements:
            if statement['Effect'] == 'Deny':
                denied.update(actions(statement))
        self.assertIn('ec2:AllocateAddress', denied)
        self.assertIn('ec2:ReleaseAddress', denied)

    def test_dangerous_services_are_denied(self):
        denied = set()
        for statement in self.statements:
            if statement['Effect'] == 'Deny':
                denied.update(actions(statement))
        for service in ('iam:*', 'organizations:*', 's3:*', 'cloudformation:*', 'ssm:*'):
            self.assertIn(service, denied)

    # ------------------------------------------------------------- launch set
    def test_launch_is_pinned_to_one_instance_type(self):
        launch = [s for s in self.statements
                  if s['Effect'] == 'Allow'
                  and 'ec2:RunInstances' in actions(s)
                  and any(':instance/*' in r for r in resources(s))]
        self.assertTrue(launch)
        condition = launch[0]['Condition']['StringEquals']
        self.assertEqual(condition.get('ec2:InstanceType'), 't3.micro')
        self.assertEqual(condition.get('aws:RequestedRegion'), REGION)

    def test_terminate_is_run_tag_scoped(self):
        terminate = [s for s in self.statements
                     if s['Effect'] == 'Allow' and 'ec2:TerminateInstances' in actions(s)]
        self.assertTrue(terminate)
        condition = terminate[0]['Condition']['StringEquals']
        self.assertEqual(condition.get('ec2:ResourceTag/RunId'), RUN_ID)
        self.assertEqual(condition.get('ec2:ResourceTag/Project'), PROJECT)

    def test_no_wildcard_resource_on_mutating_allow(self):
        mutating = re.compile(r'^(ec2:(Run|Terminate|Delete|Create|Modify|Authorize|Revoke)|'
                              r'cloudwatch:(Put|Delete)|budgets:(Create|Modify))')
        for statement in self.statements:
            if statement['Effect'] != 'Allow':
                continue
            if not any(mutating.match(a) for a in actions(statement)):
                continue
            for resource in resources(statement):
                self.assertNotEqual(resource, '*', f"{statement['Sid']} allows '*' for a mutation")


if __name__ == '__main__':
    unittest.main()
