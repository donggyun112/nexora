/**
 * Runnable narration of the authority-attenuation demo.
 *
 *   pnpm --filter @nexora-examples/authority-attenuation build
 *   pnpm --filter @nexora-examples/authority-attenuation start
 */

import { runAuthorityDemo } from './demo.js';

const { inheritedByChild, outcomes } = await runAuthorityDemo();

console.log('\n  Delegation authority attenuation — end to end\n');
console.log('  Parent authority : docs.read, docs.write');
console.log('  Granted to child : docs.read            (authorityForChild)');
console.log(`  Child received   : ${(inheritedByChild ?? ['(unrestricted)']).join(', ')}   ← over the transport hop\n`);

for (const o of outcomes) {
  const mark = o.allowed ? '✓ allowed' : '✗ DENIED ';
  console.log(`  ${mark}  ${o.tool.padEnd(11)} [${o.group}]`);
}

console.log('\n  → The child can never gain docs.write — attenuation enforced at the gate.\n');
