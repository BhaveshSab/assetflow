// Disposable CI test diagnostics only; do not log environment variables.
const fs = require('node:fs');
const escape = (value) => String(value)
  .replace(/\u001b\[[0-9;]*m/g, '')
  .replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.log('::warning title=e2e diagnostics::Jest did not produce JSON results; inspect startup/global setup in the job log.');
} else {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const suite of report.testResults || []) {
    const failures = (suite.assertionResults || []).filter(test => test.status === 'failed');
    for (const failure of failures) {
      const detail = `${failure.fullName}\n${(failure.failureMessages || []).join('\n')}`;
      console.log(`::error title=Backend e2e::${escape(detail.slice(0, 5000))}`);
    }
    if (suite.status === 'failed' && !failures.length) {
      console.log(`::error title=Backend e2e suite::${escape(`${suite.name}\n${suite.message || 'Suite failed before assertions'}`.slice(0, 5000))}`);
    }
  }
}
