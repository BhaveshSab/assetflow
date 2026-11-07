// Vercel serverless entrypoint. Delegates to the compiled Nest app in dist/,
// which `vercel.json`'s buildCommand produces before the function is bundled.
//
// This file must stay dependency-free and must never throw while it is being
// loaded. Everything below the first `try` used to be a single line —
// `module.exports = require('../dist/serverless').default` — and that is a
// silent way to break a deployment: if the compiled application cannot be
// loaded (a file missing from the bundle, an incompatible dependency, a build
// that emitted nothing), the failure happens *before any handler exists*.
// Vercel then answers its own `500 FUNCTION_INVOCATION_FAILED`, with no
// `Access-Control-Allow-Origin` header, and the browser reports
//
//     Access to fetch at '…/api/auth/login' … blocked by CORS policy:
//     No 'Access-Control-Allow-Origin' header is present
//
// which is a lie: the server never got as far as CORS. The load error is
// captured here instead, and reported as JSON with the header the browser
// needs in order to read it.

/** Same rule as `src/common/http/cors.ts`, kept inline so it can never fail. */
function allowedOrigins() {
  const raw = (process.env.CORS_ORIGINS || '').trim();
  const list = (raw || 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return list.length > 0 ? list : ['http://localhost:5173'];
}

/** The headers a browser needs before it will show our own error body. */
function corsHeaders(origin) {
  const headers = { Vary: 'Origin' };
  if (!origin) return headers;
  const clean = String(origin).trim().replace(/\/+$/, '');
  const origins = allowedOrigins();
  if (origins.includes('*') || origins.includes(clean)) {
    headers['Access-Control-Allow-Origin'] = clean;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

function sendJson(res, req, status, message) {
  if (res.headersSent) return;
  res.statusCode = status;
  for (const [name, value] of Object.entries(
    corsHeaders(req.headers && req.headers.origin),
  )) {
    res.setHeader(name, value);
  }
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({ statusCode: status, error: 'Service Unavailable', message }),
  );
}

// Where `nest build` puts the compiled app depends on which files it compiles:
// `backend/src/**` alone emits `dist/serverless.js`, but one extra root (e.g. a
// script) shifts everything to `dist/src/serverless.js`. That difference is
// invisible in the build log and fatal at runtime, so both layouts are tried
// and the one that worked is reported. `tsconfig.build.json` excludes
// `scripts/` so the flat layout is the intended one.
const CANDIDATES = ['../dist/serverless', '../dist/src/serverless'];

let handler;
let loaded;
let loadError;

const failures = [];

for (const candidate of CANDIDATES) {
  try {
    const loadedModule = require(candidate);
    const candidateHandler = loadedModule && loadedModule.default;
    if (typeof candidateHandler === 'function') {
      handler = candidateHandler;
      loaded = candidate;
      break;
    }
    failures.push(
      `${candidate}: no default export function (default is ${typeof candidateHandler})`,
    );
  } catch (err) {
    failures.push(`${candidate}: ${(err && err.message) || String(err)}`);
  }
}

// Every path is reported, not just the last failure: the interesting message
// is usually the *first* one (the file exists, something it requires does not).
if (!handler) {
  loadError = new Error(failures.join(' | '));
}

if (handler) {
  console.log(`[assetflow] serverless handler loaded from ${loaded}`);
}

module.exports = async function entry(req, res) {
  if (loadError) {
    console.error('[assetflow] the API could not be loaded:', loadError);
    return sendJson(
      res,
      req,
      503,
      `AssetFlow API could not be loaded: ${loadError.message}. ` +
        `Tried ${CANDIDATES.join(' and ')}.`,
    );
  }

  try {
    return await handler(req, res);
  } catch (err) {
    console.error('[assetflow] the API threw outside its own handler:', err);
    const message = err instanceof Error ? err.message : String(err);
    return sendJson(res, req, 500, `AssetFlow API failed: ${message}`);
  }
};
