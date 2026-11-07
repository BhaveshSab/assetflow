#!/usr/bin/env node
/**
 * Does the bundle that actually ships actually start?
 *
 * Everything else in this repository tests **source**: the unit tests import
 * `.ts` files, the component tests render them in jsdom, and `tsc` only reads
 * types. None of that looks at the files a browser downloads, so none of it
 * could see the bug this script exists for:
 *
 *   2026-11-07 — `vendor-*.js` and `react-*.js` formed a circular import.
 *   `use-sync-external-store` copies `React.useState` into a variable while
 *   its module body runs, so when the browser evaluated `react` first, that
 *   variable was `undefined` and the app died before painting:
 *
 *       TypeError: Cannot read properties of undefined (reading 'useState')
 *
 *   `npm test` (92 checks) and `npm run build` were both green. The site was
 *   a blank white page.
 *
 * So this script does the two things that would have caught it:
 *
 *   1. **Cycle check** — parses the emitted chunks' imports and fails if any
 *      cycle exists, naming it (`react ⇄ vendor`). Cheap, exact, and it fails
 *      with a sentence instead of a browser stack trace.
 *   2. **Boot check** — loads the real entry chunk in jsdom, with the browser
 *      globals React touches, and asserts that (a) module evaluation does not
 *      throw and (b) React put something on the page.
 *
 * Usage:
 *   node scripts/bundle-smoke.mjs            # uses ./dist
 *   node scripts/bundle-smoke.mjs out-dir    # any build directory
 *
 * Exit code 1 on any failure, so CI stops.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const DIST = resolve(process.argv[2] ?? "dist");
const INDEX = join(DIST, "index.html");

if (!existsSync(INDEX)) {
  console.error(
    `No ${INDEX}. Build first:  npm run build && node scripts/bundle-smoke.mjs`,
  );
  process.exit(1);
}

const failures = [];
const pass = (message) => console.log(`  ✓ ${message}`);
const fail = (message) => {
  failures.push(message);
  console.log(`  ✗ ${message}`);
};

// ---------------------------------------------------------------------------
// 1. The chunk graph must be acyclic
// ---------------------------------------------------------------------------

console.log(`\nBundle smoke test — ${DIST}\n`);

const assets = join(DIST, "assets");
const jsFiles = readdirSync(assets).filter((file) => file.endsWith(".js"));

/** Static imports only: the first statement of a chunk lists its dependencies. */
function staticImports(file) {
  const head = readFileSync(join(assets, file), "utf8").slice(0, 4000);
  return new Set(
    [...head.matchAll(/from"\.\/([A-Za-z0-9._-]+\.js)"/g)].map((m) => m[1]),
  );
}

const graph = Object.fromEntries(jsFiles.map((f) => [f, staticImports(f)]));

/** Every cycle in the graph, each as an array of chunk names. */
function findCycles(edges) {
  const cycles = [];
  const done = new Set();

  const walk = (node, path) => {
    if (path.includes(node)) {
      cycles.push([...path.slice(path.indexOf(node)), node]);
      return;
    }
    if (done.has(node)) return;
    done.add(node);
    for (const next of edges[node] ?? []) walk(next, [...path, node]);
  };

  for (const node of Object.keys(edges)) walk(node, []);
  return cycles;
}

const cycles = findCycles(graph);
if (cycles.length === 0) {
  pass(`${jsFiles.length} chunks, no circular imports`);
} else {
  for (const cycle of cycles) {
    fail(`circular import between chunks: ${cycle.join(" → ")}`);
  }
  console.log(
    "\n    A cycle between chunks makes the page depend on the order the\n" +
      "    browser happens to evaluate them. Put the modules that reference\n" +
      "    each other in the same chunk (see manualChunks in vite.config.ts).",
  );
}

// ---------------------------------------------------------------------------
// 2. The entry chunk must boot and render
// ---------------------------------------------------------------------------

const html = readFileSync(INDEX, "utf8");
const entryMatch = html.match(/<script[^>]+src="\/?(assets\/index-[^"]+\.js)"/);
if (!entryMatch) {
  fail("could not find the entry chunk in index.html");
} else {
  const entry = entryMatch[1];
  const { JSDOM } = await import("jsdom");

  const dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    { url: "https://bundle-smoke.test/", pretendToBeVisual: true },
  );
  const { window } = dom;

  // The globals React, React Router and the theme helper touch on import.
  // Deliberately minimal: the smoke test is about module evaluation, not about
  // exercising the app.
  for (const key of [
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "CustomEvent",
    "MutationObserver",
    "getComputedStyle",
    "localStorage",
    "sessionStorage",
  ]) {
    if (globalThis[key] === undefined && window[key] !== undefined) {
      globalThis[key] = window[key];
    }
  }
  globalThis.self = window;
  globalThis.matchMedia ??= () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame ??= clearTimeout;

  try {
    // The exact file the browser would execute.
    await import(new URL(entry, `file://${DIST}/`).href);
    pass(`${entry} evaluated without throwing`);
  } catch (error) {
    fail(`${entry} threw on evaluation: ${error.constructor.name}: ${error.message}`);
    const frame = (error.stack ?? "").split("\n").find((l) => l.includes(".js:"));
    if (frame) console.log(`    at ${frame.trim()}`);
  }

  if (failures.length === 0) {
    // React 18 renders concurrently: give it a tick before counting.
    await new Promise((done) => setTimeout(done, 400));
    const root = window.document.getElementById("root");
    const nodes = root ? root.querySelectorAll("*").length : 0;
    const text = (root?.textContent ?? "").trim();

    if (nodes > 0) {
      pass(`React rendered ${nodes} nodes into #root`);
      console.log(`    first paint: ${JSON.stringify(text.slice(0, 70))}…`);
    } else {
      fail("the entry evaluated but rendered nothing into #root");
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nBundle smoke test FAILED (${failures.length} problem(s)).\n`);
  process.exit(1);
}

console.log("\nBundle smoke test passed.\n");
// The app leaves animation frames and timers running; stop deliberately.
process.exit(0);
