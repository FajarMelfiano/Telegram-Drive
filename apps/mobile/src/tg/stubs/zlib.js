/* global Buffer */
/**
 * Stub `zlib` / `node:zlib` untuk Metro/RN — implementasi murni JS via pako.
 *
 * Dipakai teleproto untuk:
 * - `unzipSync` (tl/core/GZIPPacked.ungzip) — MENDUKUNG data server yang
 *   di-gzip. Wajib nyata: tanpa ini "unzipSync is not a function".
 * - `crc32` (Helpers.js) — teleproto punya fallback CRC32 JS sendiri,
 *   jadi cukup ekspor apa adanya (undefined → fallback aktif).
 *
 * GZIPPacked.gzip di teleproto sengaja no-op (Buffer.from), jadi kompresi
 * keluaran tidak diperlukan; gzipSync tetap disediakan untuk jaga-jaga.
 */
const pako = require('pako');

function toU8(buf) {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  return new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
}

/** Deteksi otomatis seperti zlib.unzipSync: gzip (1f 8b) vs format zlib. */
function unzipSync(buf) {
  const u8 = toU8(buf);
  if (u8.length > 1 && u8[0] === 0x1f && u8[1] === 0x8b) {
    return Buffer.from(pako.ungzip(u8));
  }
  return Buffer.from(pako.inflate(u8));
}

module.exports = {
  unzipSync,
  gunzipSync: (buf) => Buffer.from(pako.ungzip(toU8(buf))),
  inflateSync: (buf) => Buffer.from(pako.inflate(toU8(buf))),
  gzipSync: (buf) => Buffer.from(pako.gzip(toU8(buf))),
  deflateSync: (buf) => Buffer.from(pako.deflate(toU8(buf))),
};
