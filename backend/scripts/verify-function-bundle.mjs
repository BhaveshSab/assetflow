/**
 * Does the Vercel function actually contain the application it imports?
 *
 * The API has been deployed three times in a state where it could not start,
 * and every time the build, the linter, the type checker and the whole test
 * suite were green — because none of them look at what the *bundler* puts in
 * the deployment. What the bundler puts in is decided by `@vercel/nft`, which
 * follows `require`/`import` from `api/index.js` by **static analysis**:
 *
 *  - a `require(variable)` is invisible to it, so nothing behind it is
 *    included (this shipped once: the bundle held two files and the runtime
 *    said `Cannot find module '@nestjs/core'`);
 *  - if `require('../dist/serverless')` cannot be resolved — e.g. the build
 *    emitted `dist/src/serverless.js` instead — tracing stops at that line and
 *    the same thing happens.
 *
 * So this runs the real tracer over the real entrypoint and fails if the
 * graph it produces could not possibly boot.
 *
 * Run after `npm run build`: `npm run check:bundle`.
 */
import { nodeFileTrace } from '@vercel/nft';
import { statSync } from 'node:fs';

const ENTRY = 'api/index.js';

/** Packages that must be present, with the reason they matter. */
const REQUIRED = [
  ['@nestjs/core', 'the framework itself'],
  ['@prisma/client', 'the database client'],
  ['express', 'the HTTP layer Nest runs on'],
];

const { fileList, warnings } = await nodeFileTrace([ENTRY], {
  base: process.cwd(),
});
const files = [...fileList];

if (!files.includes('dist/serverless.js')) {
  console.error(
    '✗ the trace does not reach dist/serverless.js.\n' +
      '  Either the build did not run, or `nest build` emitted dist/src/… instead\n' +
      '  (see the exclude list in tsconfig.build.json).',
  );
  process.exit(1);
}

const missing = REQUIRED.filter(
  ([name]) => !files.some((file) => file.startsWith(`node_modules/${name}/`)),
);

if (missing.length > 0) {
  console.error(
    '✗ the deployment would be missing:\n' +
      missing.map(([name, why]) => `    ${name} — ${why}`).join('\n') +
      '\n  A require(variable) or an unresolvable path is hiding the graph from\n' +
      '  the tracer. Keep the requires in api/index.js literal.',
  );
  process.exit(1);
}

let bytes = 0;
for (const file of files) {
  try {
    bytes += statSync(file).size;
  } catch {
    // A file listed but not on disk is Vercel's problem, not ours.
  }
}

console.log(`✓ ${ENTRY} traces ${files.length} files (${(bytes / 1e6).toFixed(1)} MB)`);
console.log(
  `✓ dist/serverless.js, ${REQUIRED.map(([name]) => name).join(', ')} are all included`,
);
if (warnings.size > 0) {
  console.log(`  ${warnings.size} optional dependency warning(s) — ignored`);
}
