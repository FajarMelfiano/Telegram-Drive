/* global Buffer */
/**
 * Stub node:crypto untuk RN/web.
 * Yang BENAR-BENAR dipakai teleproto saat runtime: randomBytes, randomFillSync,
 * createHash (sha1/sha256). AES utama MTProto lewat cifrante (murni JS).
 * createCipheriv/pbkdf2Sync tidak terpakai di jalur app ini → error jelas bila terpanggil.
 */
const cifrante = require('cifrante');

function getRandomValues(buf) {
  const g = globalThis.crypto;
  if (!g || typeof g.getRandomValues !== 'function') {
    throw new Error('crypto.getRandomValues tidak ada — muat src/tg/polyfills.ts SEBELUM teleproto');
  }
  g.getRandomValues(buf);
  return buf;
}

function randomBytes(count) {
  const b = Buffer.alloc(count);
  getRandomValues(b);
  return b;
}

function randomFillSync(buf, offset = 0, size = buf.length - offset) {
  getRandomValues(buf.subarray(offset, offset + size));
  return buf;
}

const HASH_IMPL = {
  sha1: cifrante.sha1,
  sha256: cifrante.sha256,
  sha512: cifrante.sha512,
  md5: cifrante.md5,
};

function createHash(algorithm) {
  const key = String(algorithm).toLowerCase().replace(/-/g, '');
  const impl = HASH_IMPL[key];
  if (!impl) throw new Error(`Hash algorithm tidak didukung polyfill: ${algorithm}`);
  const h = impl.sync.create();
  const self = {
    update(data) { h.update(data); return self; },
    digest() { return Buffer.from(h.digest()); },
  };
  return self;
}

function unsupported(name) {
  return () => { throw new Error(`node:crypto.${name} tidak tersedia di RN (tak terpakai di jalur app)`); };
}

module.exports = {
  getRandomValues,
  randomBytes,
  randomFillSync,
  createHash,
  createCipheriv: unsupported('createCipheriv'),
  createDecipheriv: unsupported('createDecipheriv'),
  pbkdf2Sync: unsupported('pbkdf2Sync'),
};
