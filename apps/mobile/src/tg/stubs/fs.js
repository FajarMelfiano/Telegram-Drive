/**
 * Stub fs untuk RN — teleproto hanya butuh fs saat API berbasis PATH dipakai.
 * Jalur app ini memakai Buffer (kirim) & Buffer (terima) → fs tidak boleh terpakai.
 * Bila terpanggil, error ini menandakan ada kode yang salah memakai jalur path.
 */
function nope(name) {
  return () => { throw new Error(`node:fs.${name} tidak tersedia di RN — pakai Buffer API (baca/tulis via expo-file-system)`); };
}

class WriteStream {
  constructor() { throw new Error('fs.WriteStream tidak tersedia di RN'); }
}

module.exports = {
  createReadStream: nope('createReadStream'),
  createWriteStream: nope('createWriteStream'),
  existsSync: () => false,
  lstatSync: nope('lstatSync'),
  statSync: nope('statSync'),
  readFileSync: nope('readFileSync'),
  writeFileSync: nope('writeFileSync'),
  promises: {
    readFile: nope('promises.readFile'),
    writeFile: nope('promises.writeFile'),
    stat: nope('promises.stat'),
    open: nope('promises.open'),
    unlink: nope('promises.unlink'),
  },
  WriteStream,
};
