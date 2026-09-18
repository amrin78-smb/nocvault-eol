/** @type {import('next').NextConfig} */

// ⛔ COMMIT_REF IS A BUILD-TIME VARIABLE AND IS ABSENT AT RUNTIME.
// Netlify sets it while building and does not pass it into the deployed
// function's environment, so `process.env.COMMIT_REF` read inside a route
// returns undefined in production — the first build marker printed "local" on
// a real deploy, a deploy indicator that could not indicate a deploy.
// `env` here is inlined by Next at build time, which is the one moment the
// value exists. Same lesson as the NVD key: read it where it actually is.
const nextConfig = {
  reactStrictMode: true,
  env: {
    BUILD_COMMIT: process.env.COMMIT_REF || 'local',
  },
};

module.exports = nextConfig;
