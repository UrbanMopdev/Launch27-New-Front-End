// Makes a new placement API token for a caller (e.g. the Sales Hub).
//   npm run placement-token -- sales-hub
// Prints two things:
//   - the token: give it to the caller only (it goes in the Sales Hub's own settings)
//   - the PLACEMENT_TOKENS entry for this app: only the token's SHA-256, never the token
// To rotate: add the new entry next to the old one (comma-separated), switch the caller over,
// then remove the old entry.
import { createHash, randomBytes } from 'node:crypto';

const name = (process.argv[2] || 'sales-hub').toLowerCase();
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
  console.error('Name the caller with lowercase letters, digits and dashes, e.g. sales-hub');
  process.exit(1);
}
const token = randomBytes(36).toString('base64url'); // 288 bits
const hash = createHash('sha256').update(token).digest('hex');
console.log(`Token for ${name} (give to the caller only; it is not stored here):\n\n  ${token}\n`);
console.log(`PLACEMENT_TOKENS entry for this app:\n\n  ${name}:sha256:${hash}\n`);
console.log('With a scope (only these actions and brands):\n');
console.log(`  [{"name":"${name}","sha256":"${hash}","actions":["read","hold","book"],"brands":["urbanmop-residential"]}]\n`);
