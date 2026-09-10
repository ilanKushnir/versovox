/* Byte-range / chunk math shared by the service worker (importScripts) and
   unit tests (CommonJS require). Pure functions only — no browser APIs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.tlRange = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  /**
   * Parse an HTTP Range header against a resource of `size` bytes.
   * Returns {start, end} (inclusive) for a satisfiable single range,
   * null for a syntactically valid but unsatisfiable range (=> 416),
   * or undefined for a header we do not handle (=> serve 200).
   */
  function parseRangeHeader(header, size) {
    if (!header || typeof header !== 'string') return undefined;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return undefined; // multi-range or malformed: serve whole (200)
    const rawStart = m[1];
    const rawEnd = m[2];
    if (rawStart === '' && rawEnd === '') return null;
    if (rawStart === '') {
      // suffix range: last N bytes
      const suffix = parseInt(rawEnd, 10);
      if (suffix === 0) return null;
      const start = Math.max(0, size - suffix);
      return { start, end: size - 1 };
    }
    const start = parseInt(rawStart, 10);
    let end = rawEnd === '' ? size - 1 : parseInt(rawEnd, 10);
    if (Number.isNaN(start) || Number.isNaN(end)) return null;
    end = Math.min(end, size - 1);
    if (start >= size || start > end) return null;
    return { start, end };
  }

  /** Indices (inclusive) of the fixed-size chunks covering [start, end]. */
  function chunkSpan(start, end, chunkSize) {
    return {
      first: Math.floor(start / chunkSize),
      last: Math.floor(end / chunkSize),
    };
  }

  /** Number of chunks a resource of `size` splits into. */
  function chunkCount(size, chunkSize) {
    return size === 0 ? 0 : Math.ceil(size / chunkSize);
  }

  /** Cache key for chunk `i` of `url` (query param — fragments are stripped by Cache API). */
  function chunkKey(url, i) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'tlchunk=' + i;
  }

  /** Cache key for the stored metadata entry of a chunked resource. */
  function metaKey(url) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'tlmeta=1';
  }

  /**
   * Slice bounds of chunk `i` relative to the requested [start, end] window.
   * Returns {from, to} to subarray the chunk's bytes ((to) exclusive).
   */
  function sliceWithin(i, chunkSize, chunkLength, start, end) {
    const chunkStart = i * chunkSize;
    return {
      from: Math.max(0, start - chunkStart),
      to: Math.min(chunkLength, end + 1 - chunkStart),
    };
  }

  return { parseRangeHeader, chunkSpan, chunkCount, chunkKey, metaKey, sliceWithin };
});
