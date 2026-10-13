/**
 * Polyfill global — WAJIB diimpor SEBELUM modul teleproto (lihat _layout.tsx).
 *
 * - Buffer: teleproto (dan deps-nya) memakai Buffer di mana-mana.
 * - crypto.getRandomValues: Hermes/RN tidak menyediakannya → expo-crypto.
 * - process: default minimal (Metro sudah mengisi NODE_ENV).
 */
import { Buffer } from 'buffer';
import * as Crypto from 'expo-crypto';

const g = globalThis as Record<string, unknown>;

if (typeof g.Buffer === 'undefined') {
  g.Buffer = Buffer;
}

if (typeof g.crypto === 'undefined' || typeof (g.crypto as CryptoWeb).getRandomValues !== 'function') {
  g.crypto = {
    // expo-crypto membatasi tipe typed-array masukan; teleproto hanya butuh
    // mutasi in-place, jadi kembalikan array yang sama apa adanya.
    getRandomValues: <T extends ArrayBufferView>(arr: T): T => {
      Crypto.getRandomValues(arr as never);
      return arr;
    },
  };
}

if (typeof g.process === 'undefined') {
  g.process = {
    env: { NODE_ENV: 'production' },
    version: '',
    versions: {},
    platform: 'android',
    nextTick: (cb: () => void) => setTimeout(cb, 0),
  };
}

// Alias Buffer khusus Node: paket npm "buffer" TIDAK menyediakan varian
// huruf-kecil (readBigUint64BE) yang dipakai teleproto/Helpers.js, sedangkan
// Buffer native Node memilikinya. Tanpa shim ini connect gagal dengan
// "TypeError: readBigUint64BE is not a function".
const proto = (g.Buffer as unknown as { prototype?: Record<string, unknown> } | undefined)?.prototype;
if (proto) {
  const aliases: [string, string][] = [
    ['readBigUint64BE', 'readBigUInt64BE'],
    ['readBigUint64LE', 'readBigUInt64LE'],
    ['writeBigUint64BE', 'writeBigUInt64BE'],
    ['writeBigUint64LE', 'writeBigUInt64LE'],
  ];
  for (const [alias, target] of aliases) {
    if (typeof proto[alias] !== 'function' && typeof proto[target] === 'function') {
      proto[alias] = proto[target];
    }
  }
}

// RN memakai paket "abort-controller" v3 (polyfill spec lama): AbortSignal-nya
// punya aborted/addEventListener (via event-target-shim) tapi TIDAK punya
// throwIfAborted (spec 2022, dipakai RpcCallControl.check() = baris PERTAMA
// client.invoke) → "TypeError: undefined is not a function" saat RPC pertama.
// Chrome/Node punya API ini (spike web/Node lolos) — makanya bug ini hanya
// muncul di Android.
if (
  typeof AbortSignal !== 'undefined' &&
  typeof AbortSignal.prototype.throwIfAborted !== 'function'
) {
  AbortSignal.prototype.throwIfAborted = function throwIfAborted(this: AbortSignal) {
    if (this.aborted) {
      const reason: unknown = this.reason;
      if (reason instanceof Error) throw reason;
      const error = new Error(typeof reason === 'string' ? reason : 'This operation was aborted');
      error.name = 'AbortError';
      throw error;
    }
  };
}

// Hermes ≠ V8: Uint8Array.prototype.subarray di Hermes TIDAK menghormati
// Symbol.species (V8 menghormatinya) → hasil Buffer.prototype.subarray()
// berupa Uint8Array murni TANPA metode Buffer (.equals, .compare, dsb).
// teleproto decryptMessageData memanggil body.subarray(8, 24).equals(...)
// → di Hermes: "TypeError: undefined is not a function" (jalur decrypt mati
// total; jalur send selamat karena buffer meng-override slice sendiri).
// Bungkus subarray agar selalu menghasilkan Buffer (view berbagi memori).
const origSubarray = Buffer.prototype.subarray;
Buffer.prototype.subarray = function patchedSubarray(
  this: Buffer,
  start?: number,
  end?: number,
): Buffer {
  const view = origSubarray.call(this, start, end);
  if (typeof (view as unknown as { equals?: unknown }).equals === 'function') {
    return view; // sudah Buffer (mis. di V8) — jangan dibungkus dua kali
  }
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
};

type CryptoWeb = { getRandomValues<T extends ArrayBufferView>(arr: T): T };

export {};
