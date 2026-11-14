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

    # ------------------------------------------------- CreateSecurityGroup
    def test_create_security_group_is_authorized_on_the_vpc(self):
        """Regression: creation was denied because this statement was absent.

        CreateSecurityGroup is authorized against the VPC, not the group - the
        live error named the VPC ARN, so a group-ARN statement would not work.

        This statement carries the region condition ONLY. aws:RequestTag/*
        describes tags on the resource being created, so it cannot match a VPC
        ARN; requiring request tags here made the statement unusable for the
        VPC authorization. The tag requirements belong on the group-scoped
        statement instead.
        """
        allows = [s for s in self.statements
                  if s['Effect'] == 'Allow'
                  and 'ec2:CreateSecurityGroup' in actions(s)
                  and any(':vpc/' in r for r in resources(s))]
        self.assertTrue(allows, 'no CreateSecurityGroup allow on the VPC')
        self.assertEqual(resources(allows[0]),
                         [f'arn:aws:ec2:{REGION}:{ACCOUNT}:vpc/vpc-0bcfe8d7f2e811bb3'])
        condition = allows[0]['Condition']['StringEquals']
        self.assertEqual(condition, {'aws:RequestedRegion': REGION},
                         'the VPC statement must carry the region condition only')

    def test_vpc_creation_statement_does_not_require_request_tags(self):
        """aws:RequestTag cannot apply to a VPC ARN, so it must not appear here.

        Pinned separately from the exact-condition check above so a failure says
        which mistake was made: a widened condition, or a request-tag condition
        that cannot match.
        """
        for statement in self.statements:
            if (statement['Effect'] == 'Allow'
                    and 'ec2:CreateSecurityGroup' in actions(statement)
                    and any(':vpc/' in r for r in resources(statement))):
                condition = statement['Condition']['StringEquals']
                for key in condition:
                    self.assertFalse(
                        key.startswith('aws:RequestTag/'),
                        f'{key} cannot match a VPC ARN')

    def test_create_security_group_is_authorized_on_new_groups(self):
        """Regression: the attached policy needed a second, group-scoped allow.

        Creation also authorizes against the security-group resource itself, so
        both statements are required. The group-scoped one must not be a bare
        wildcard: it carries the region and both run tags.
        """
        allows = [s for s in self.statements
                  if s['Effect'] == 'Allow'
                  and 'ec2:CreateSecurityGroup' in actions(s)
                  and any(':security-group/' in r for r in resources(s))]
        self.assertTrue(allows, 'no CreateSecurityGroup allow on security-group/*')
        for statement in allows:
            condition = statement['Condition']['StringEquals']
            self.assertEqual(condition.get('aws:RequestedRegion'), REGION)
            self.assertEqual(condition.get('aws:RequestTag/Project'), PROJECT)
            self.assertEqual(condition.get('aws:RequestTag/RunId'), RUN_ID)

    def test_both_create_security_group_statements_are_present(self):
        # One covers the VPC, one covers the new group. Losing either breaks
        # creation, and the failure only appears at run time.
        allows = [s for s in self.statements
                  if s['Effect'] == 'Allow' and 'ec2:CreateSecurityGroup' in actions(s)]
        targets = set()
        for statement in allows:
            for resource in resources(statement):
                if ':vpc/' in resource:
                    targets.add('vpc')
                elif ':security-group/' in resource:
                    targets.add('security-group')
        self.assertEqual(targets, {'vpc', 'security-group'},
                         f'expected both resource authorizations, got {targets}')

    def test_creation_time_tagging_covers_the_security_group(self):
        # Tagging at creation must be permitted for the group, or the single
        # tagged request fails even though creation itself is allowed.
        allows = [s for s in self.statements
                  if s['Effect'] == 'Allow' and 'ec2:CreateTags' in actions(s)
                  and any(':security-group/' in r for r in resources(s))]
        self.assertTrue(allows, 'security-group/* missing from CreateTags')
        condition = allows[0]['Condition']['StringEquals']
        self.assertEqual(condition.get('ec2:CreateAction'), 'CreateSecurityGroup')
        self.assertEqual(condition.get('aws:RequestTag/RunId'), RUN_ID)

    def test_no_invalid_budget_action_names_are_present(self):
        # Regression: CreateBudget and DescribeBudgets do not exist. Creation and
        # update authorize against ModifyBudget; reads use ViewBudget.
        allowed = set()
        for statement in self.statements:
            if statement['Effect'] == 'Allow':
                allowed.update(actions(statement))
        for invalid in ('budgets:CreateBudget', 'budgets:DescribeBudgets'):
            self.assertNotIn(invalid, allowed, f'{invalid} is not a real IAM action')
        for valid in ('budgets:ViewBudget', 'budgets:ModifyBudget'):
            self.assertIn(valid, allowed)

    def test_no_duplicate_statements(self):
        # Each statement must be distinct: a duplicate would waste the managed
        # policy size limit without adding any authority.
        seen = set()
        for statement in self.statements:
            key = (
                statement['Effect'],
                tuple(sorted(actions(statement))),
                tuple(sorted(resources(statement))),
                json.dumps(statement.get('Condition', {}), sort_keys=True),
            )
            self.assertNotIn(key, seen, f"duplicate statement: {statement.get('Sid')}")
            seen.add(key)

    def test_policy_fits_the_managed_policy_limit_without_sid_labels(self):
        """The attachment omits Sid labels to fit the 6144-character limit.

        Measured the same way as the attachment: compact JSON, no Sid keys.
        """
        document = {'Version': self.policy['Version'],
                    'Statement': [{k: v for k, v in s.items() if k != 'Sid'}
                                  for s in self.statements]}
        compact = json.dumps(document, separators=(',', ':'))
        self.assertLessEqual(len(compact), 6144, 'managed policy size limit exceeded')
        self.assertEqual(len(compact), 6137,
                         'expected the attachment size after the read permission')
        self.assertEqual(len(self.statements), 21)

    def test_instance_shutdown_behaviour_is_readable(self):
        """Regression: describe-instances does NOT return
        InstanceInitiatedShutdownBehavior, and DescribeInstanceAttribute was not
        granted, so the lifecycle setting could not be verified at all.

        Read-back is the only proof that `terminate` took effect; without this
        permission the run would depend on trusting the request.
        """
        allowed = set()
        for statement in self.statements:
            if statement['Effect'] == 'Allow':
                allowed.update(actions(statement))
        self.assertIn('ec2:DescribeInstanceAttribute', allowed)

    def test_describe_instance_attribute_is_the_only_addition(self):
        """The fix is a read permission, not a broadening. No write action may
        have been added alongside it."""
        allowed = set()
        for statement in self.statements:
            if statement['Effect'] == 'Allow':
                allowed.update(actions(statement))
        for write in ('ec2:ModifyInstanceAttribute', 'ec2:StopInstances',
                      'ec2:StartInstances', 'ec2:CreateTags'):
            # CreateTags is granted, but only under CreateAction conditions.
            if write == 'ec2:CreateTags':
                continue
            self.assertNotIn(write, allowed, f'{write} must not be an Allow')

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
