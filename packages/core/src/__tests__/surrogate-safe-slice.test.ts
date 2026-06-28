import { describe, it, expect } from 'vitest';
import { safeHead, safeTail } from '../surrogate-safe-slice.js';

// 😀 = U+1F600 = surrogate pair 😀
const EMOJI = '😀';

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('safeHead', () => {
  it('does not end mid surrogate pair', () => {
    const s = `ab${EMOJI}cd`; // a b D83D DE00 c d
    // cutting at index 3 would keep the high surrogate but drop the low half
    expect(safeHead(s, 3)).toBe('ab');
    expect(hasLoneSurrogate(safeHead(s, 3))).toBe(false);
  });

  it('keeps a whole pair when the boundary is past it', () => {
    const s = `ab${EMOJI}cd`;
    expect(safeHead(s, 4)).toBe(`ab${EMOJI}`);
  });

  it('returns whole string when n >= length, empty when n <= 0', () => {
    expect(safeHead('abc', 10)).toBe('abc');
    expect(safeHead('abc', 0)).toBe('');
  });
});

describe('safeTail', () => {
  it('does not start mid surrogate pair', () => {
    const s = `ab${EMOJI}cd`; // length 6: indices 0,1,2(hi),3(lo),4,5
    // slice(-3) would start at index 3 (the lone low surrogate)
    expect(safeTail(s, 3)).toBe('cd');
    expect(hasLoneSurrogate(safeTail(s, 3))).toBe(false);
  });

  it('keeps a whole pair when the boundary is before it', () => {
    const s = `ab${EMOJI}cd`;
    expect(safeTail(s, 4)).toBe(`${EMOJI}cd`);
  });
});

describe('round trip head+tail never leaves a lone surrogate', () => {
  it('emoji-dense string sliced at every boundary stays well-formed', () => {
    const s = `${EMOJI}${EMOJI}${EMOJI}${EMOJI}${EMOJI}`;
    for (let n = 0; n <= s.length; n++) {
      expect(hasLoneSurrogate(safeHead(s, n))).toBe(false);
      expect(hasLoneSurrogate(safeTail(s, n))).toBe(false);
    }
  });
});
