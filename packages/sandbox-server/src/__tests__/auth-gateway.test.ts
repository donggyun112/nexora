import { describe, it, expect } from 'vitest';
import { isPathAllowed, sanitizeForwardHeaders } from '../auth-gateway.js';

describe('isPathAllowed', () => {
  it('allows an exact prefix match and sub-paths', () => {
    expect(isPathAllowed('/v1/messages', ['/v1/messages'])).toBe(true);
    expect(isPathAllowed('/v1/messages?beta=true', ['/v1/messages'])).toBe(true);
  });
  it('rejects paths outside the allowlist', () => {
    expect(isPathAllowed('/v1/organizations', ['/v1/messages'])).toBe(false);
    expect(isPathAllowed('/../secrets', ['/v1/messages'])).toBe(false);
  });
});

describe('sanitizeForwardHeaders', () => {
  it('strips jail auth + hop headers and injects the real credential', () => {
    const out = sanitizeForwardHeaders(
      {
        authorization: 'Bearer dummy-no-authority',
        'x-api-key': 'dummy',
        host: '127.0.0.1',
        connection: 'keep-alive',
        'content-length': '2235',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219',
        'content-type': 'application/json',
      },
      { authorization: 'Bearer REAL-TOKEN', 'anthropic-beta': 'oauth-2025-04-20,claude-code-20250219' },
    );
    expect(out.authorization).toBe('Bearer REAL-TOKEN');
    expect(out['x-api-key']).toBeUndefined();
    expect(out.host).toBeUndefined();
    expect(out.connection).toBeUndefined();
    expect(out['content-length']).toBeUndefined();
    expect(out['anthropic-version']).toBe('2023-06-01');
    expect(out['content-type']).toBe('application/json');
    // inject overrides an incoming same-named header
    expect(out['anthropic-beta']).toBe('oauth-2025-04-20,claude-code-20250219');
  });
});
