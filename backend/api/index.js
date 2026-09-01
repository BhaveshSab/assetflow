// Vercel serverless entrypoint. Delegates to the compiled Nest app in dist/,
// which `vercel.json`'s buildCommand produces before the function is bundled.
module.exports = require('../dist/serverless').default;
