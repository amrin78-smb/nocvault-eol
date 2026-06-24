/**
 * Generate an Ed25519 keypair for signing the published EOL feed.
 *
 *  - PRIVATE key (pkcs8 DER, base64) → set as the FEED_SIGNING_KEY build secret
 *    (used by scripts/build-feed.ts to sign the canonical feed bytes).
 *  - PUBLIC key (spki DER, base64) → bundle into each consuming app so it can
 *    verify the detached signature against feed.json.
 *
 * Secrets are printed to stdout ONLY — nothing is written to disk.
 */

import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

const publicB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const privateB64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

console.log('=== Ed25519 feed signing keypair ===\n');
console.log('PUBLIC KEY (spki DER, base64) — bundle into consuming apps for verification:');
console.log(publicB64);
console.log('');
console.log('PRIVATE KEY (pkcs8 DER, base64) — set as the FEED_SIGNING_KEY build secret:');
console.log(privateB64);
console.log('');
console.log('Instructions:');
console.log('  1. Set the PRIVATE key as the FEED_SIGNING_KEY secret in your build');
console.log('     environment (GitHub Actions secret / Netlify env var). Keep it secret.');
console.log('  2. Bundle the PUBLIC key into each consuming app (NocVault et al.) so it');
console.log('     can verify the detached Ed25519 signature on feed.json.');
console.log('  3. Do NOT commit either key to the repo.');
