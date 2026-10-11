import { createReadStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';

/**
 * Penulis ZIP minimal (method STORE / tanpa kompresi, tanpa ZIP64).
 *
 * Kenapa STORE: file Telegram sudah terkompresi (video/gambar/arsip), dan STORE
 * membuat streaming jadi sederhana — ukuran sudah diketahui dari metadata file,
 * CRC32 dihitung dari file temp sebelum header ditulis, lalu isi di-stream apa
 * adanya. Batas: entri > 4GB tidak didukung (ZIP32) — cukup untuk personal-use.
 *
 * Aturan format yang dipakai:
 * - Local file header (30 byte) per entri, lalu isi mentah.
 * - Central directory (46 byte + nama) di akhir, lalu EOCD (22 byte).
 * - Flag 0x0800 → nama file dibaca sebagai UTF-8 (aman untuk emoji/unicode).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 streaming per-byte (tabel) — cukup cepat untuk ukuran file personal. */
async function crc32File(path: string): Promise<number> {
  let crc = 0xFFFFFFFF;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]!) & 0xFF]!;
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]!) & 0xFF]!;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** Waktu DOS (format waktu zip) dari Date sekarang. */
function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 4) | d.getDate();
  return { time, date };
}

function localHeader(name: Buffer, crc: number, size: number, time: number, date: number): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(20, 4);          // version needed
  b.writeUInt16LE(0x0800, 6);      // flag: UTF-8 names
  b.writeUInt16LE(0, 8);           // method: store
  b.writeUInt16LE(time, 10);
  b.writeUInt16LE(date, 12);
  b.writeUInt32LE(crc, 14);
  b.writeUInt32LE(size, 18);       // compressed
  b.writeUInt32LE(size, 22);       // uncompressed
  b.writeUInt16LE(name.length, 26);
  b.writeUInt16LE(0, 28);          // extra len
  return Buffer.concat([b, name]);
}

function centralEntry(name: Buffer, crc: number, size: number, time: number, date: number, offset: number): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE(20, 4);          // version made by
  b.writeUInt16LE(20, 6);          // version needed
  b.writeUInt16LE(0x0800, 8);      // UTF-8
  b.writeUInt16LE(0, 10);          // store
  b.writeUInt16LE(time, 12);
  b.writeUInt16LE(date, 14);
  b.writeUInt32LE(crc, 16);
  b.writeUInt32LE(size, 20);
  b.writeUInt32LE(size, 24);
  b.writeUInt16LE(name.length, 28);
  b.writeUInt16LE(0, 30);          // extra
  b.writeUInt16LE(0, 32);          // comment
  b.writeUInt16LE(0, 34);          // disk
  b.writeUInt16LE(0, 36);          // internal attrs
  b.writeUInt32LE(0, 38);          // external attrs
  b.writeUInt32LE(offset, 42);     // local header offset
  return Buffer.concat([b, name]);
}

function eocd(count: number, cdSize: number, cdOffset: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(0, 4);
  b.writeUInt16LE(0, 6);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(cdSize, 12);
  b.writeUInt32LE(cdOffset, 16);
  b.writeUInt16LE(0, 20);
  return b;
}

export interface ZipSource {
  /** Nama file di dalam zip (boleh unicode; flag UTF-8 aktif). */
  name: string;
  /** Ambil isi file ke `destPath`. Return false / throw = entri dilewati. */
  fetch: (destPath: string) => Promise<boolean>;
}

/** Buat nama unik dalam satu zip (hindari tabrakan "a.pdf" dua kali). */
function dedupe(used: Set<string>, raw: string): string {
  if (!used.has(raw)) { used.add(raw); return raw; }
  const dot = raw.lastIndexOf('.');
  const base = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot) : '';
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

/**
 * Stream ZIP: unduh satu per satu ke temp → CRC → header → stream isi → hapus temp.
 * Entri gagal diunduh dilewati (streaming sudah jalan, status HTTP tak bisa diubah).
 * Bila tidak ada satu pun entri sukses, hasilnya tetap ZIP kosong yang valid.
 */
export function createZipStream(sources: ZipSource[], tmpDir: string): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    const central: Buffer[] = [];
    const used = new Set<string>();
    const { time, date } = dosDateTime(new Date());
    let offset = 0;
    let count = 0;

    for (const src of sources) {
      const dest = join(tmpDir, `td-zip-${randomUUID()}`);
      let ok = false;
      try {
        ok = await src.fetch(dest);
      } catch {
        ok = false;
      }
      if (!ok) {
        await unlink(dest).catch(() => undefined);
        continue;
      }
      try {
        const size = (await stat(dest)).size;
        if (size > 0xFFFFFFFF) continue; // di luar ZIP32 — lewati, jangan corrupt
        const crc = await crc32File(dest);
        const name = Buffer.from(dedupe(used, src.name), 'utf8');
        const headerOffset = offset; // posisi awal local header (dibutuhkan central dir)
        const header = localHeader(name, crc, size, time, date);
        yield header;
        offset += header.length;

        const content = createReadStream(dest);
        for await (const chunk of content) {
          const buf = chunk as Buffer;
          offset += buf.length;
          yield buf;
        }

        central.push(centralEntry(name, crc, size, time, date, headerOffset));
        count++;
      } finally {
        await unlink(dest).catch(() => undefined);
      }
    }

    if (count > 0) {
      const cd = Buffer.concat(central);
      yield cd;
      yield eocd(count, cd.length, offset);
    } else {
      yield eocd(0, 0, 0); // ZIP kosong yang tetap valid
    }
  }

  return Readable.from(generate());
}
