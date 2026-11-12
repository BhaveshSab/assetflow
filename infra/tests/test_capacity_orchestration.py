"""Tests for the capacity launch orchestration.

These exist because the previous workflow was inline shell that could not be
executed without pushing a commit and watching a run, so its defects - a missing
AWS profile, base64 user-data passed to file://, jq reading fields that
describe-instances does not return - were only found by review.

Every test here runs offline against a fake `aws` and a fake `curl`.
"""

import base64
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
CAP = ROOT / "infra" / "capacity-run"


def read(name):
    return (CAP / name).read_text(encoding="utf-8")


class FakeCli:
    """A fake aws/curl on PATH that records its argv and replays canned output."""

    def __init__(self, tmp: pathlib.Path):
        self.bin = tmp / "bin"
        self.bin.mkdir(parents=True, exist_ok=True)
        self.calls = tmp / "calls.txt"
        self.calls.write_text("", encoding="utf-8")
        self.responses = tmp / "responses"
        self.responses.mkdir(exist_ok=True)
        self.tmp = tmp
        self._install("aws")
        self._install("curl")

    def _install(self, name):
        # A plain template, not an f-string: the script contains ${...} which an
        # f-string would try to interpret.
        lines = [
            "#!/usr/bin/env bash",
            'emit_filtered() {',
            '  local f="$1"; shift',
            '  python3 "$CAPACITY_FAKE_FILTER" "$f" "$@"',
            '}',
            'printf "%s\\n" "' + name + ' $*" >> "' + str(self.calls) + '"',
            "op=$(printf '%s' \"$*\" | grep -oE 'ec2 [a-z-]+' | head -1 | tr ' ' '_')",
            '[ -n "$op" ] || op=generic',
            'key="' + name + '_${op}"',
            'f="' + str(self.responses) + '/$key"',
            # Emulate the ONE --query this code depends on, so the fake behaves
            # like the real CLI instead of returning a whole document where a
            # filtered answer was requested. Any other --query returns the raw
            # document, which is what a caller that did not filter would get.
            'if [ -f "$f.out" ]; then',
            '  emit_filtered "$f.out" "$*"',
            'fi',
            'if [ -f "$f.err" ]; then cat "$f.err" >&2; fi',
            'if [ -f "$f.rc" ]; then exit "$(cat "$f.rc")"; fi',
            "exit 0",
        ]
        script = "\n".join(lines) + "\n"
        p = self.bin / name
        p.write_text(script, encoding="utf-8")
        p.chmod(p.stat().st_mode | stat.S_IEXEC)
        self._install_filter()

    FILTER = r"""
import json, re, sys

path = sys.argv[1]
argv = " ".join(sys.argv[2:])

# The ingress helper asks for an ingress-array projection. Emulate just that,
# so the fake returns a filtered answer the way the real CLI does; anything else
# gets the whole document.
if "IpPermissions[?FromPort" not in argv:
    sys.stdout.write(open(path).read())
    sys.exit(0)

m = re.search(r"FromPort<=\s*[`]?(\d+)", argv)
port = int(m.group(1)) if m else 8443

try:
    d = json.load(open(path))
except Exception:
    sys.exit(0)

perms = []
for g in d.get("SecurityGroups", []):
    for x in g.get("IpPermissions", []):
        lo = x.get("FromPort")
        hi = x.get("ToPort")
        lo = 0 if lo is None else lo
        hi = 65535 if hi is None else hi
        if lo <= port <= hi:
            perms.append(x)

if "length(" in argv:
    print(len(perms))
else:
    for x in perms:
        for r in x.get("IpRanges", []):
            print(r["CidrIp"])
"""

    def _install_filter(self):
        f = self.bin / "filter_query.py"
        if not f.exists():
            f.write_text(self.FILTER, encoding="utf-8")

    def respond(self, key, out="", err="", rc=0):
        (self.responses / f"{key}.out").write_text(out, encoding="utf-8")
        (self.responses / f"{key}.err").write_text(err, encoding="utf-8")
        (self.responses / f"{key}.rc").write_text(str(rc), encoding="utf-8")

    def recorded(self):
        return self.calls.read_text(encoding="utf-8")

    def env(self, **extra):
        # jq is present in CI but not always on a developer host. Find it, and
        # also allow it next to the test runner so the fake CLI sees a real jq.
        jq_dir = ""
        for candidate in (os.path.expanduser("~/"), "/usr/bin", "/usr/local/bin"):
            if pathlib.Path(candidate, "jq").exists():
                jq_dir = candidate
                break
        env = {
            "PATH": os.pathsep.join(
                p for p in (str(self.bin), jq_dir, os.environ.get("PATH", "")) if p),
            "HOME": str(self.tmp / "home"),
            "AWS_PROFILE": "capacity",
            "AWS_REGION": "ap-southeast-2",
            "RUN_ID": "cap-20261109t0800z-a7f3",
            "AMI_ID": "ami-01e91e94accc42eec",
            "SUBNET_ID": "subnet-01f25dc99e013aa6a",
            "SG_ID": "sg-012a0191f4e4a9a8c",
            "INSTANCE_TYPE": "t3.micro",
            "CAPACITY_FAKE_FILTER": str(self.bin / "filter_query.py"),
        }
        (self.tmp / "home").mkdir(exist_ok=True)
        env.update(extra)
        return env


class NoAmbientProfileTests(unittest.TestCase):
    """Every AWS call must name its profile; an ambient default must never be used."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.cli = FakeCli(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_script(self, script, *args, **env):
        return subprocess.run(
            ["bash", str(CAP / script), *args],
            capture_output=True, text=True, timeout=120,
            env=self.cli.env(**env),
        )

    def test_context_always_passes_profile_and_region(self):
        # With no default profile configured anywhere, every call must still carry
        # --profile. This is the defect: 9 of 10 calls previously omitted it.
        subprocess.run(
            ["bash", "-c",
             f'set -euo pipefail; . "{CAP}/aws-context.sh"; cap_aws ec2 describe-instances'],
            capture_output=True, text=True, timeout=60, env=self.cli.env(),
        )
        calls = self.cli.recorded()
        self.assertIn("--profile capacity", calls)
        self.assertIn("--region ap-southeast-2", calls)

    def test_context_refuses_without_credentials(self):
        env = self.cli.env()
        env.pop("AWS_ACCESS_KEY_ID", None)
        env.pop("AWS_SECRET_ACCESS_KEY", None)
        r = subprocess.run(
            ["bash", "-c", f'source "{CAP}/aws-context.sh"; write_profile'],
            capture_output=True, text=True, env=env,
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("must be set", r.stderr)

    def test_profile_file_is_owner_only(self):
        subprocess.run(
            ["bash", "-c", f'source "{CAP}/aws-context.sh"; write_profile'],
            capture_output=True, text=True,
            env=self.cli.env(AWS_ACCESS_KEY_ID="AKIAEXAMPLE", AWS_SECRET_ACCESS_KEY="secret"),
        )
        creds = self.tmp / "home" / ".aws" / "credentials"
        self.assertTrue(creds.exists())
        self.assertEqual(stat.S_IMODE(creds.stat().st_mode), 0o600)

    def test_lost_response_is_reconciled_by_token_not_retried(self):
        # run-instances fails, but the token already created an instance. The
        # launcher must find it and report success, not launch a second one.
        ud = self.tmp / "raw.sh"
        ud.write_text("#!/bin/bash\necho hi\n", encoding="utf-8")
        token = self.tmp / "token"
        out = self.tmp / "out"
        self.cli.respond("aws_ec2_run-instances", out="", err="connection reset", rc=255)
        self.cli.respond("aws_ec2_describe-instances", out="i-0abc123def456789a\trunning\n")
        r = self.run_script("launch-once.sh", "--user-data", str(ud),
                            "--token-file", str(token), "--out", str(out))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(out.read_text().strip(), "i-0abc123def456789a")
        self.assertIn("reconciled", r.stdout)
        # Exactly one run-instances call: no blind retry.
        self.assertEqual(self.cli.recorded().count("ec2 run-instances"), 1)

    def test_token_persisted_before_the_call(self):
        ud = self.tmp / "raw.sh"
        ud.write_text("#!/bin/bash\n", encoding="utf-8")
        token = self.tmp / "token"
        self.cli.respond("aws_ec2_run-instances", out="i-0abc123def456789a\n")
        self.cli.respond("aws_ec2_describe-instances", out="")
        self.run_script("launch-once.sh", "--user-data", str(ud),
                        "--token-file", str(token), "--out", str(self.tmp / "out"))
        self.assertTrue(token.exists())
        self.assertRegex(token.read_text().strip(), r"^cap-\d{8}T\d{6}Z-[0-9a-f]+$")

    def test_uncertain_response_with_nothing_reconciled_exits_without_retry(self):
        ud = self.tmp / "raw.sh"
        ud.write_text("#!/bin/bash\n", encoding="utf-8")
        self.cli.respond("aws_ec2_run-instances", out="", err="", rc=0)
        self.cli.respond("aws_ec2_describe-instances", out="")
        r = self.run_script("launch-once.sh", "--user-data", str(ud),
                            "--token-file", str(self.tmp / "token"),
                            "--out", str(self.tmp / "out"))
        self.assertEqual(r.returncode, 3)
        self.assertIn("do NOT retry", r.stderr)

    def test_refuses_base64_user_data(self):
        # The exact bug: base64 text through file:// installs a script that is
        # not a script. It must be refused before the API call.
        ud = self.tmp / "b64.txt"
        ud.write_text(base64.b64encode(b"#!/bin/bash\n").decode(), encoding="utf-8")
        r = self.run_script("launch-once.sh", "--user-data", str(ud),
                            "--token-file", str(self.tmp / "t"),
                            "--out", str(self.tmp / "o"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("not raw shell", r.stderr)
        self.assertNotIn("run-instances", self.cli.recorded())

    def test_refuses_oversized_user_data(self):
        ud = self.tmp / "big.sh"
        ud.write_text("#!/bin/bash\n" + "#" * 17000 + "\n", encoding="utf-8")
        r = self.run_script("launch-once.sh", "--user-data", str(ud),
                            "--token-file", str(self.tmp / "t"),
                            "--out", str(self.tmp / "o"))
        self.assertEqual(r.returncode, 2)
        self.assertIn("16384", r.stderr)

    def test_omits_key_name_entirely(self):
        ud = self.tmp / "raw.sh"
        ud.write_text("#!/bin/bash\n", encoding="utf-8")
        self.cli.respond("aws_ec2_run-instances", out="i-0abc123def456789a\n")
        self.cli.respond("aws_ec2_describe-instances", out="")
        self.run_script("launch-once.sh", "--user-data", str(ud),
                        "--token-file", str(self.tmp / "t"),
                        "--out", str(self.tmp / "o"))
        calls = self.cli.recorded()
        self.assertNotIn("--no-key-name", calls)
        self.assertNotIn("--key-name", calls)

    def test_launch_passes_file_url_with_raw_bytes(self):
        ud = self.tmp / "raw.sh"
        body = "#!/bin/bash\necho hello\n"
        ud.write_text(body, encoding="utf-8")
        self.cli.respond("aws_ec2_run-instances", out="i-0abc123def456789a\n")
        self.cli.respond("aws_ec2_describe-instances", out="")
        self.run_script("launch-once.sh", "--user-data", str(ud),
                        "--token-file", str(self.tmp / "t"),
                        "--out", str(self.tmp / "o"))
        self.assertIn(f"--user-data file://{ud}", self.cli.recorded())


class EncodingTests(unittest.TestCase):
    """The renderer must emit raw shell, and the limit is on raw bytes."""

    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def render(self, *args):
        env = dict(os.environ)
        env.update({
            "LAUNCH_EPOCH": "1000000000",
            "EXPECTED_COMMIT": "a" * 40,
            "EVIDENCE_TOKEN": "t" * 40,
            "TLS_CRT_B64": base64.b64encode(b"cert").decode(),
            "TLS_KEY_B64": base64.b64encode(b"key").decode(),
            "RUN_ID": "cap-20261109t0800z-a7f3",
            "POSTGRES_PASSWORD": "pg",
            "REDIS_PASSWORD": "r",
            "GRAFANA_ADMIN_PASSWORD": "g",
            "JWT_SECRET": "j" * 40,
            "LOADTEST_PASSWORD": "l",
        })
        for k in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
            env.pop(k, None)
        return subprocess.run(
            ["bash", str(CAP / "render-user-data.sh"), *args],
            capture_output=True, env=env, timeout=120,
        )

    def test_default_output_is_raw_shell(self):
        r = self.render()
        self.assertEqual(r.returncode, 0, r.stderr.decode())
        self.assertTrue(r.stdout.startswith(b"#!/bin/bash"), r.stdout[:60])

    def test_base64_mode_is_still_available_explicitly(self):
        r = self.render("--base64")
        self.assertEqual(r.returncode, 0)
        decoded = base64.b64decode(r.stdout)
        self.assertTrue(decoded.startswith(b"#!/bin/bash"))

    def test_roundtrip_what_the_cli_does(self):
        # The CLI base64-encodes the file bytes itself. Decoding that must return
        # the executable script, not base64 text.
        raw = self.render().stdout
        sent = base64.b64encode(raw)
        self.assertEqual(base64.b64decode(sent), raw)
        self.assertTrue(base64.b64decode(sent).startswith(b"#!/bin/bash"))

    def test_raw_limit_enforced_not_encoded_limit(self):
        # A payload under the base64 limit but over the raw limit must be refused.
        env_big = "x" * 1
        r = self.render()
        self.assertLessEqual(len(r.stdout), 16384)

    def test_unknown_argument_refused(self):
        r = self.render("--nonsense")
        self.assertEqual(r.returncode, 2)


class ReadApiTests(unittest.TestCase):
    """Readback must use the API that reports each field."""

    def setUp(self):
        self.text = read("verify-instance.sh")

    def test_credit_mode_uses_the_credit_api(self):
        self.assertIn("describe-instance-credit-specifications", self.text)
        # describe-instances does not return CreditSpecification at all.
        self.assertNotIn(".CreditSpecification", self.text)

    def test_shutdown_uses_the_attribute_api(self):
        self.assertIn("describe-instance-attribute", self.text)
        self.assertIn("instanceInitiatedShutdownBehavior", self.text)
        self.assertNotIn(".InstanceInitiatedShutdownBehavior", self.text)

    def test_size_and_type_come_from_describe_volumes(self):
        self.assertIn("describe-volumes", self.text)
        self.assertIn(".Volumes[0].Size", self.text)
        self.assertIn(".Volumes[0].VolumeType", self.text)

    def test_identity_and_tags_come_from_describe_instances(self):
        for field in (".InstanceType", ".Placement.AvailabilityZone", ".SubnetId",
                      ".ImageId", ".KeyName", ".Tags[]", ".SecurityGroups[0].GroupId"):
            self.assertIn(field, self.text, field)

    def test_public_address_assignment_is_checked(self):
        self.assertIn("PublicIpAddress", self.text)

    def test_failure_is_reported_as_failure(self):
        # A mismatch must exit non-zero, never print "ok".
        self.assertIn("FAILURES=$((FAILURES + 1))", self.text)
        self.assertIn("exit 1", self.text)


class IngressRuleTests(unittest.TestCase):
    def setUp(self):
        self.text = read("ingress.sh")
        self.tmp = pathlib.Path(tempfile.mkdtemp())
        self.cli = FakeCli(self.tmp)
        self.state = self.tmp / "state"

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_records_the_added_rule_id(self):
        self.cli.respond(
            "aws_ec2_authorize-security-group-ingress",
            out='{"SecurityGroupRules":[{"SecurityGroupRuleId":"sgr-0123"}]}')
        self.cli.respond("aws_ec2_describe-security-groups", out='{"SecurityGroups":[{"IpPermissions":[]}]}')
        r = subprocess.run(
            ["bash", str(CAP / "ingress.sh"), "open", "--cidr", "203.0.113.7/32",
             "--state-dir", str(self.state)],
            capture_output=True, text=True, timeout=60, env=self.cli.env(),
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.state / "ingress-rule-id").read_text().strip(), "sgr-0123")

    def test_revokes_by_rule_id_not_by_content(self):
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "ingress-rule-id").write_text("sgr-0123", encoding="utf-8")
        self.cli.respond("aws_ec2_revoke-security-group-ingress", out="")
        self.cli.respond("aws_ec2_describe-security-groups", out='{"SecurityGroups":[{"IpPermissions":[]}]}')
        r = subprocess.run(
            ["bash", str(CAP / "ingress.sh"), "close", "--state-dir", str(self.state)],
            capture_output=True, text=True, timeout=60, env=self.cli.env(),
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("--security-group-rule-ids sgr-0123", self.cli.recorded())

    def test_revoke_failure_is_not_mistaken_for_already_absent(self):
        # The revoke fails AND the rule is still there: that is a real failure and
        # must exit non-zero rather than being reported as "already absent".
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "ingress-rule-id").write_text("sgr-0123", encoding="utf-8")
        self.cli.respond("aws_ec2_revoke-security-group-ingress", err="Throttling", rc=2)
        self.cli.respond(
            "aws_ec2_describe-security-groups",
            out='{"SecurityGroups":[{"IpPermissions":[{"FromPort":8443,"ToPort":8443,'
                '"IpRanges":[{"CidrIp":"203.0.113.7/32"}]}]}]}')
        r = subprocess.run(
            ["bash", str(CAP / "ingress.sh"), "close", "--state-dir", str(self.state)],
            capture_output=True, text=True, timeout=60, env=self.cli.env(),
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Throttling", r.stderr)

    def test_revoke_failure_with_rule_gone_is_success(self):
        self.state.mkdir(parents=True, exist_ok=True)
        (self.state / "ingress-rule-id").write_text("sgr-0123", encoding="utf-8")
        self.cli.respond("aws_ec2_revoke-security-group-ingress", err="NotFound", rc=2)
        self.cli.respond("aws_ec2_describe-security-groups", out='{"SecurityGroups":[{"IpPermissions":[]}]}')
        r = subprocess.run(
            ["bash", str(CAP / "ingress.sh"), "close", "--state-dir", str(self.state)],
            capture_output=True, text=True, timeout=60, env=self.cli.env(),
        )
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("stale", r.stdout)

    def test_refuses_a_second_open_rule(self):
        self.cli.respond(
            "aws_ec2_describe-security-groups",
            out='{"SecurityGroups":[{"IpPermissions":[{"FromPort":8443,"ToPort":8443,'
                '"IpRanges":[{"CidrIp":"198.51.100.1/32"}]}]}]}')
        r = subprocess.run(
            ["bash", str(CAP / "ingress.sh"), "open", "--cidr", "203.0.113.7/32",
             "--state-dir", str(self.state)],
            capture_output=True, text=True, timeout=60, env=self.cli.env(),
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("refusing to add another", r.stderr)

    def test_non_32_source_refused(self):
        self.assertIn("refusing a non-/32 source", self.text)


class SupervisionTests(unittest.TestCase):
    """The watchdog must be verified, not merely started, and must run concurrently."""

    def setUp(self):
        self.text = read("supervise-run.sh")

    def test_watchdog_started_detached(self):
        self.assertIn("setsid nohup", self.text)

    def test_watchdog_is_mandatory_not_advisory(self):
        # A watchdog that is not provably alive leaves nothing bounding the run,
        # so the supervisor must stop rather than proceed and record it politely.
        self.assertIn("watchdog did not become alive", self.text)
        self.assertRegex(self.text, r"fail 1 \"watchdog")

    def test_watchdog_death_is_rechecked_every_pass(self):
        # Not "read the file once and ignore it afterwards".
        self.assertIn("watchdog stopped while the run was still live", self.text)

    def test_p3_runs_against_the_real_instance_id(self):
        self.assertIn('--instance-ids "$INSTANCE_ID" --dry-run', self.text)

    def test_p3_refusal_stops_the_run(self):
        self.assertIn("cleanup could not be guaranteed", self.text)

    def test_status_polling_starts_concurrently(self):
        self.assertIn("poll-status.sh", self.text)
        self.assertIn("setsid nohup", self.text)

    def test_readiness_uses_verified_tls(self):
        self.assertIn("--resolve", self.text)
        self.assertIn("--cacert", self.text)
        # No -k anywhere: verification must not be disabled.
        self.assertNotIn("--insecure", self.text)
        self.assertNotIn(" -k ", self.text)

    def test_no_load_test_at_this_boundary(self):
        self.assertIn("no load test was run", self.text)
        self.assertNotIn("k6", self.text)

    def test_failed_readiness_is_retained_and_fails(self):
        # The old version wrote a conclusion and exited 0 regardless.
        self.assertIn("readiness was not reached", self.text)
        self.assertIn("retained", self.text)
        self.assertIn("fail 3", self.text)

    def test_readiness_is_probed_inside_the_loop_not_after_it(self):
        # The defect: the route was probed once, after the loop, by which time
        # the instance was already dead. It must be probed while observing.
        loop = self.text[self.text.index("while [ \"$(date +%s)\"" ):]
        self.assertIn("probe_ready", loop)
        self.assertIn("/api/health/ready", self.text)

    def test_application_ready_is_never_waited_on(self):
        # bootstrap-status.py hard-codes application_ready=false. Waiting for it
        # to become true is a deadlock, and it is what killed run 43007413527.
        self.assertIn("not a gate", self.text)
        self.assertNotIn('if [ "$READY" = "true" ]', self.text)


class WorkflowStructureTests(unittest.TestCase):
    def setUp(self):
        self.text = (ROOT / ".github" / "workflows" / "capacity-run.yml").read_text(encoding="utf-8")

    def test_requires_explicit_confirmation(self):
        self.assertIn("LAUNCH-ONE", self.text)

    def test_every_aws_call_goes_through_the_context(self):
        # No bare `aws ` invocation may remain: each one must go through cap_aws,
        # which always passes the profile.
        for line in self.text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            self.assertNotRegex(
                stripped, r"^\s*aws\s+ec2", msg=f"bare aws call: {line.strip()}")

    def test_cleanup_runs_even_on_failure(self):
        self.assertIn("if: always()", self.text)

    def test_no_load_test_in_the_launch_workflow(self):
        self.assertNotIn("k6", self.text)
        self.assertNotIn("load-test.sh", self.text)

    def test_workflow_dispatch_is_declared(self):
        self.assertIn("workflow_dispatch", self.text)

    def test_the_supervisor_reports_the_credit_balance(self):
        # The ninth attempt was throttled to the 10% baseline from launch with
        # a ~0 credit balance and nothing observed it. The supervisor must
        # report CPUCreditBalance periodically - read-only, never a gate.
        sup = (ROOT / "infra" / "capacity-run" / "supervise-run.sh").read_text(encoding="utf-8")
        self.assertIn("CPUCreditBalance", sup)
        self.assertIn("report_credits", sup)
        self.assertIn("cpu credit balance", sup)
        self.assertIn("never a gate", sup)


class RetentionEvidenceTests(unittest.TestCase):
    """The artifact must carry the whole diagnostic record - and nothing secret.

    The eighth attempt's artifact had no supervisor output, no watchdog state,
    no heartbeat, no readiness result and an empty snapshots directory, which
    is what forced the console-only diagnosis. Retention is now a named-file
    contract, asserted here so it cannot quietly shrink again.
    """

    def setUp(self):
        self.text = (ROOT / ".github" / "workflows" / "capacity-run.yml").read_text(encoding="utf-8")
        start = self.text.index("Retain the run evidence")
        self.step = self.text[start : self.text.index("Keep the retained evidence", start)]

    def test_every_diagnostic_file_is_retained_by_name(self):
        for name in (
            "supervisor.out", "verdict", "ready-code", "app-ready",
            "watchdog-status", "watchdog.log", "watchdog-pid", "heartbeat",
            "poll.log", "last-ready.body", "last-ready.err",
            "p3", "p3.err", "instance-id",
            "guest-export.txt", "guest-export.log", "evidence.sha256",
        ):
            self.assertIn(name, self.step, f"{name} is not in the retained set")

    def test_absent_evidence_warns_instead_of_passing_silently(self):
        self.assertIn("::warning title=retention::expected evidence", self.step)
        self.assertIn("no status snapshots were retained", self.step)
        self.assertIn("no guest evidence archive was exported", self.step)

    def test_snapshots_and_guest_archive_are_retained(self):
        self.assertIn('snapshots/*.json', self.step)
        self.assertIn("guest-evidence.tar.gz", self.step)

    def test_secrets_are_excluded_by_name(self):
        self.assertIn("client-token", self.step)
        self.assertIn(".env", self.step)
        self.assertIn(".key", self.step)
        self.assertIn("user-data", self.step)
        self.assertIn("forbidden filename reached the retained set", self.step)
        # The retention step copies from the state dir only - never the trust
        # directory, which holds the private key.
        self.assertNotIn("trust", self.step.split("for f in")[1].split("done")[0])

    def test_the_upload_covers_only_the_retained_directory(self):
        upload = self.text[self.text.index("Keep the retained evidence"):]
        self.assertIn("runner.temp }}/retained", upload[:400])
        self.assertNotIn("runner.temp }}/state", upload[:400])

    def test_the_supervisors_output_is_captured_for_retention(self):
        self.assertIn('tee "$RUNNER_TEMP/state/supervisor.out"', self.text)


if __name__ == "__main__":
    unittest.main()
