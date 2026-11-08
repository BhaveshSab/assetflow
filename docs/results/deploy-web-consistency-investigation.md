# Green deployment with a stale frontend: investigation

## Scope and provenance

Base inspected: `bb3e20e470c0a152d4b6d57203b46358d6baf8fd`.
Fix: the commit containing this report on `arena/75eddab5-assetflow` (CI/run
links are attached to its PR). This is an isolated code/regression investigation,
not a production rollout or a complete application/recovery verification.

### Operator-supplied host evidence

The operator's terminal reported `2026-11-08T13:13:30Z`. This is the host's
reported timestamp, not a claim about the sandbox clock. These observations
were supplied by the operator, not collected through assistant SSH access:

| Observation | Value |
| --- | --- |
| API configured reference | `ghcr.io/bhaveshsab/assetflow-api:bb3e20e470c0a152d4b6d57203b46358d6baf8fd` |
| Running API image ID | `sha256:6fb8b5d9bfbcbe3afd832320db30fa2863ff1fbd63a1b1d949cd5390bc6f64a9` |
| Web configured reference | `ghcr.io/bhaveshsab/assetflow-web:latest` |
| Running web image ID | `sha256:0cbfda4bc482522e6d757d6168dc658c2c119d8f780949c13afc2eb14fee6497` |
| Locally available web release reference | `ghcr.io/bhaveshsab/assetflow-web:bb3e20e470c0a152d4b6d57203b46358d6baf8fd` |
| Expected web release image ID | `sha256:6daae6abfeb477b6ce67d11cc7e1736677fb4f5b8f9ac624c5a121bd735ffd5f` |
| Local readiness | HTTP 200 |

The web image IDs differ. Readiness and the screenshot of successful Deploy
#53 therefore do not establish frontend release consistency. API reference and
ID were recorded, but immutable API provenance was not independently resolved.
The host also reported Compose v5.6.1 in a preceding batch; diagnosing this as
an old plugin without actual command/error evidence is unwarranted.

## Reproduced code defect

The old workflow sends its commands directly to `bash -s` over SSH. Child
processes inherit that same stdin. `-T` disables the TTY, not stdin, on Compose
clients. A child that reads stdin can consume later shell commands, skipping
web activation while returning success.

A control experiment executed the **base workflow's actual remote script**
through real local Bash with stub SSH/Docker/Git. The deploy child deliberately
read stdin. Expected unsafe behavior was reproduced: exit 0, web activation
not called, and web activation source present in the child's captured input.
No actual AWS, Git or Docker deployment was performed by this control.

This is a concrete reproduced bug consistent with the observed mismatch. It
is **not proof of which specific child consumed stdin on the actual host**;
the host execution log is still required to establish that history.

## Fix

- Fully receive the remote script into a private temporary file before running
  it, giving the executing script `/dev/null` as stdin. Attempt normal/failure
  cleanup of the temporary script. Forced kill can prevent cleanup.
- Independently close stdin on migration and Prometheus exec calls in deploy.sh,
  including protection for callers other than the updated workflow.
- Require actual running API and Nginx image IDs to equal their locally pulled
  release references after activation. Missing/mismatched containers fail.
- Require a full-commit completion marker in runner output; SSH exit 0 alone
  can no longer report success after premature termination.

The change does not add an atomic whole-stack rollback. Public TLS, served
assets/cache behavior, authenticated business flows and database integrity
remain separate acceptance checks.

## Verification

Commands run locally on the fixed worktree:

```text
.venv/bin/python -m unittest discover -s infra/tests -p 'test_*.py' -v
.venv/bin/python infra/scripts/check-yaml.py
.venv/bin/shellcheck --severity=warning --external-sources infra/scripts/*.sh infra/scripts/lib/*.sh
bash -n and ShellCheck on the extracted workflow Deploy and remote script
```

Local outcome: **31 passed, 1 skipped** (32 Python tests total); YAML, Bash
syntax and ShellCheck passed. The real-Compose test is skipped locally because
Docker is unavailable, not counted as a pass. Infra CI runs that test in its
own disposable Compose project with no public ports, secrets or cloud access;
its eventual outcome must be read from the matching PR run.

Coverage includes real Bash/timeout transport with stdin-reading children,
API/web ID mismatch, deployment/activation/inspection failures, absent completion
marker, quoted paths, streaming, host locking, release pins and unchanged
rollback behavior. Operational mocks do not establish actual production CLI
behavior. A real-Compose exec-without-TTY test supplements these in infra CI.

Test fixtures and their private directories are removed by their test contexts.
The CI-only Docker test removes its uniquely named disposable project in a
finally block. Inspect that CI result before claiming its cleanup succeeded.

## Remaining operational gates

No production deployment, merge, container change, migration, resource creation,
credential use or AWS load test was performed for this investigation. Do not
merge/roll out without the agreed backup/recovery and explicit approval gates.
After an approved rollout, repeat the operator's selected image-ID inspection,
public HTTPS readiness and served-asset checks, then authenticated feature tests.
The larger A–G verification matrix remains incomplete.
