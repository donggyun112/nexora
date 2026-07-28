import { describe, it, expect } from 'vitest';
import { runAuthorityDemo } from './demo.js';

describe('delegation authority attenuation — end to end', () => {
  it('propagates an attenuated authority to the child and denies escalation', async () => {
    const result = await runAuthorityDemo();

    // Parent holds {docs.read, docs.write} but grants the child only {docs.read};
    // the child receives exactly that subset over the transport hop.
    expect(result.inheritedByChild).toEqual(['docs.read']);

    const read = result.outcomes.find((o) => o.group === 'docs.read');
    const write = result.outcomes.find((o) => o.group === 'docs.write');

    // In-grant tool runs; out-of-grant tool is denied at the child's gate.
    expect(read?.allowed).toBe(true);
    expect(write?.allowed).toBe(false);
    expect(write?.detail).toContain('DENIED');
  });
});
