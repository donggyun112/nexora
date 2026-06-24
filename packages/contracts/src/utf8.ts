export function utf8SafeSliceEnd(buffer: Buffer, maxBytes: number): number {
  const end = Math.min(buffer.length, maxBytes);
  if (end === 0) return 0;

  let continuationBytes = 0;
  while (
    continuationBytes < 4 &&
    end - 1 - continuationBytes >= 0 &&
    (buffer[end - 1 - continuationBytes] & 0b1100_0000) === 0b1000_0000
  ) {
    continuationBytes += 1;
  }

  const leadIndex = end - 1 - continuationBytes;
  if (leadIndex < 0) return end - continuationBytes;

  const lead = buffer[leadIndex];
  const expectedBytes =
    (lead & 0b1000_0000) === 0 ? 1 :
      (lead & 0b1110_0000) === 0b1100_0000 ? 2 :
        (lead & 0b1111_0000) === 0b1110_0000 ? 3 :
          (lead & 0b1111_1000) === 0b1111_0000 ? 4 :
            0;

  if (expectedBytes === 0) return leadIndex;
  if (expectedBytes === 1) {
    return continuationBytes === 0 ? end : leadIndex;
  }
  return continuationBytes + 1 >= expectedBytes ? end : leadIndex;
}

export function safeUtf8Prefix(buffer: Buffer, maxBytes: number): Buffer {
  const end = utf8SafeSliceEnd(buffer, maxBytes);
  return end === buffer.length ? buffer : buffer.subarray(0, end);
}

export function safeUtf8Suffix(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0b1100_0000) === 0b1000_0000) {
    start += 1;
  }
  return buffer.subarray(start);
}
