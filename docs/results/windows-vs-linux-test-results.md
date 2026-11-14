# Test results: PR #31 head `9702366` on Linux and on Windows

Evidence classes: EXECUTED (run in this session), CI (GitHub Actions run), REPORTED
(supplied by another party, not reproduced), BLOCKED, NOT RUN.

## The authoritative Linux result (EXECUTED)

Real Ubuntu 26.04 / Python 3.14.4 / PyYAML 6.0.3, clean clone at
`970236601b95eebe85d80691472bca3a1f0aff70`:

```
Ran 93 tests in 11.884s
OK (skipped=1)
```

93 collected, 92 passed, 1 skipped, **0 failed**. This independently reproduces the
"92 passed / 1 skipped" figure that was previously only REPORTED. It is now
EXECUTED on Linux.

The single skip is genuine and self-describing:

```
test_real_compose_exec_without_tty_cannot_consume_script_payload
  ... skipped 'Docker unavailable; real-Compose test runs in infra CI'
```

It is guarded by `@unittest.skipUnless(shutil.which('docker'), ...)` in
`infra/tests/test_deploy_stdin.py:136`. A skip is not a pass: the real-Compose
stdin isolation is **NOT RUN** locally.

## CI corroboration (CI)

Run 42513782236, conclusion `success`, head_sha
`970236601b95eebe85d80691472bca3a1f0aff70`, branch `arena/595baf83-assetflow`.
All four jobs succeeded: API load regression, Frontend, Backend, Infrastructure.

The Infrastructure job runs `python3 -m unittest discover -s infra/tests -p 'test_*.py' -v`
(`.github/workflows/ci.yml:175`) and that step passed, so CI independently shows the
suite passes on Linux.

**Limit:** the per-job log endpoint returned HTTP 403 ("Must have admin rights to
Repository"), and the check-run annotations carry only a runner-image notice. The
exact test count is therefore not visible from CI; the count above comes from the
EXECUTED Linux run, not from CI.

## Windows result and the cause of each failure (EXECUTED, environmental)

On Windows 11 / Python 3.14.6 / Git Bash the same suite reports
`Ran 80 tests ... FAILED (failures=22, errors=8, skipped=1)`. Note the collector
finds only 80 of 93 tests because one module cannot even be imported.

Every failure was traced to one of four host-environment causes. None is a defect
in the shipped scripts, and none contradicts the Linux result.

### Cause 1 — the hardcoded POSIX `PATH` meets the Microsoft Store `python3` stub

`infra/tests/test_load_test_guard.py:30` sets
`PATH=/usr/bin:/bin:/usr/sbin:/sbin`. On Windows `/usr/bin/python3` resolves to the
Microsoft Store App Execution Alias stub, which prints "Python was not found" and
exits non-zero. `infra/scripts/load-test.sh` therefore aborts at its
`command -v python3` origin-validation gate with
`[FAIL] python3 is required for origin validation`.

Affected: `test_production_target_is_refused`, `test_production_is_refused_in_any_spelling`
(all 7 spellings), `test_any_sslip_name_is_treated_as_production`,
`test_explicit_override_allows_production`, `test_guard_refusal_is_what_blocks_not_a_syntax_error`,
`test_the_run_needs_no_preset_stages_variable`, `test_a_disposable_stack_is_allowed`
(3 targets), and `test_real_load_cannot_start_even_with_legacy_override`.

Verification that the guard logic itself is correct: running `load-test.sh` directly
with a working interpreter on `PATH` refuses all six production spellings
(including `https://operator@13.55.90.25`, the userinfo bypass) and allows the three
disposable targets. The production safeguard behaves as designed; only the test's
fixed `PATH` cannot find a working `python3` on Windows.

### Cause 2 — `fcntl` is POSIX-only

`infra/tests/test_deploy_runner.py:2` does `import fcntl`, so the whole module fails
to import (`ModuleNotFoundError: No module named 'fcntl'`) and its tests are never
collected. `fcntl` is used only to *simulate* the host lock in the test; the
production script uses the `flock(1)` utility
(`.github/workflows/deploy.yml:219`), which is unaffected.

Affected: all of `test_deploy_runner` (module-level import error, counted as 1 error).

### Cause 3 — POSIX-only path substitution in the remote-deploy fixture

`infra/tests/test_deploy_stdin.py` builds the command with
`run.replace('out=/tmp/deploy-remote.log', 'out="$OUT_FILE"')` and asserts on a
`drained` marker file. On Windows that substitution and the `/tmp` redirect do not
behave the same way, so `drained` is never created and `read_text()` raises
`FileNotFoundError`.

Affected: `test_deploy_activation_and_inspection_errors_remain_failures` (4 modes),
`test_stale_api_or_web_cannot_pass_with_successful_commands` (2 modes),
`test_stdin_reading_children_cannot_skip_web_activation_and_verification`.

### Cause 4 — fixture fidelity, not script defects (two cases)

- `test_matching_remote_bytes_allow_retention_and_success_metric` fails with
  "uploaded ... checksum mismatch". The `aws` stub matches on
  `*' - --only-show-errors'` and reads `$3` as the object name, which does not
  correspond to the real argument layout the script uses. A faithful stub reproduces
  the intended behaviour: `backup.sh` completes, prints
  "both S3 objects match the local bytes", prunes and writes the off-host success
  metric (EXECUTED by hand).
- `test_isolated_flow_and_failures` and `test_failed_checksum_download_removes_private_temporary_dump`
  compare a Docker-stub manifest produced with `find ... | sort -z | xargs -0`
  under Windows. `sort -z` / `xargs -0` behaviour on the Windows toolchain does not
  reproduce the Linux byte ordering, so the manifest comparison fails before any
  cleanup assertion runs.

## What this does and does not establish

| Claim | Status |
|---|---|
| PR #31 head passes the full infra suite on Linux | EXECUTED (93/92/1) |
| CI is green at the exact PR head | CI (run 42513782236) |
| Exact test count visible in CI logs | BLOCKED (403 admin rights) |
| Windows failures are host-environment causes | EXECUTED, each cause traced above |
| Production load gate and rebuild gate still refuse | EXECUTED on PR head |
| Real Docker / PostgreSQL / Prisma restore integration | NOT RUN (Docker absent) |
| Live TLS, S3 restore, production load, rebuild | NOT RUN |

No fixture was modified in this pass. Any future fixture correction must add Linux
regression coverage and must not weaken the production safeguards.
