/**
 * Character-slicing that never cuts a UTF-16 surrogate pair in half.
 *
 * Truncating a string with `slice(0, n)` / `slice(-n)` can land the boundary
 * between a high and low surrogate, leaving a lone surrogate. JS tolerates it,
 * but `JSON.stringify` emits a bare `\uD83D` escape and strict JSON parsers
 * (e.g. the Anthropic API) reject the request body with a 400 "no low surrogate
 * in string". Every length-based truncation here routes through these helpers so
 * a split pair can never reach the wire.
 */

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** `s.slice(0, n)` that never ends on a high surrogate (its low half cut off). */
export function safeHead(s: string, n: number): string {
  if (n <= 0) return '';
  if (n >= s.length) return s;
  return s.slice(0, isHighSurrogate(s.charCodeAt(n - 1)) ? n - 1 : n);
}

/** `s.slice(-n)` that never starts on a low surrogate (its high half cut off). */
export function safeTail(s: string, n: number): string {
  if (n <= 0) return '';
  if (n >= s.length) return s;
  const start = s.length - n;
  return s.slice(isLowSurrogate(s.charCodeAt(start)) ? start + 1 : start);
}
