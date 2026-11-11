function safeInteger(value) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Parse one RFC 9110 byte range.
 * Returns null when the header is absent, malformed, or uses an unsupported
 * multi-range form (the caller should serve the complete representation).
 * Returns { unsatisfiable: true } for a syntactically valid range that cannot
 * select any bytes from the representation.
 */
export function parseByteRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError("Representation size must be a non-negative safe integer.");
  }
  if (header == null || String(header).trim() === "") return null;
  const value = String(header).trim();
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value);
  if (!match || (!match[1] && !match[2])) return null;

  if (size === 0) return { unsatisfiable: true };

  if (!match[1]) {
    const suffixLength = safeInteger(match[2]);
    if (suffixLength === null) return null;
    if (suffixLength === 0) return { unsatisfiable: true };
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = safeInteger(match[1]);
  const requestedEnd = match[2] ? safeInteger(match[2]) : size - 1;
  if (start === null || requestedEnd === null) return null;
  if (start >= size || requestedEnd < start) return { unsatisfiable: true };
  return { start, end: Math.min(requestedEnd, size - 1) };
}
