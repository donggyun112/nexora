import { describe, it, expect } from 'vitest';
import { normalizePublicHttpUrl, isPublicHost } from '../url-safety.js';

// SSRF guard regression coverage — these classify whether an outbound fetch
// target is a public host. A silent regression here re-opens SSRF, so the
// blocked cases (cloud metadata, RFC1918, loopback, link-local, CGNAT) are the
// load-bearing assertions.

describe('isPublicHost', () => {
  it('accepts public hostnames and IPs', () => {
    for (const h of ['example.com', 'sub.example.co.uk', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      expect(isPublicHost(h), h).toBe(true);
    }
  });

  it('rejects loopback / localhost / internal TLDs', () => {
    for (const h of ['localhost', 'app.localhost', 'db.local', '127.0.0.1', '127.1.2.3', '::1']) {
      expect(isPublicHost(h), h).toBe(false);
    }
  });

  it('rejects RFC1918 / link-local / CGNAT / multicast IPv4', () => {
    for (const h of [
      '10.0.0.1',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '169.254.169.254', // cloud metadata endpoint
      '100.64.0.1', // CGNAT
      '0.0.0.0',
      '224.0.0.1', // multicast
    ]) {
      expect(isPublicHost(h), h).toBe(false);
    }
  });

  it('honours the 172.16/12 and 100.64/10 boundaries', () => {
    expect(isPublicHost('172.32.0.1')).toBe(true); // just outside private block
    expect(isPublicHost('100.128.0.1')).toBe(true); // just outside CGNAT block
  });

  it('rejects unique-local / link-local IPv6 and IPv4-mapped privates', () => {
    for (const h of ['fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '[::1]']) {
      expect(isPublicHost(h), h).toBe(false);
    }
  });

  it('rejects bare single-label hosts (no dot)', () => {
    expect(isPublicHost('intranet')).toBe(false);
  });
});

describe('normalizePublicHttpUrl', () => {
  it('returns the normalized href for public http(s) URLs', () => {
    expect(normalizePublicHttpUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(normalizePublicHttpUrl('  http://8.8.8.8/x  ')).toBe('http://8.8.8.8/x');
  });

  it('rejects non-http(s) schemes', () => {
    for (const u of ['ftp://example.com', 'file:///etc/passwd', 'data:text/plain,hi', 'gopher://example.com']) {
      expect(normalizePublicHttpUrl(u), u).toBeNull();
    }
  });

  it('rejects internal/private targets (SSRF)', () => {
    for (const u of [
      'http://127.0.0.1/x',
      'http://localhost:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5/secret',
      'http://192.168.1.1/',
      'https://[::1]/x',
    ]) {
      expect(normalizePublicHttpUrl(u), u).toBeNull();
    }
  });

  it('returns null for unparseable input', () => {
    expect(normalizePublicHttpUrl('not a url')).toBeNull();
    expect(normalizePublicHttpUrl('')).toBeNull();
  });
});
