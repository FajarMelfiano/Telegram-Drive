import type { ClassifiedFile, FileCategory } from './types.js';

/** Mime eksplisit → kategori (urutan tidak penting, exact match). */
const MIME_EXPLICIT: Record<string, FileCategory> = {
  'application/pdf': 'dokumen',
  'application/msword': 'dokumen',
  'application/vnd.ms-word': 'dokumen',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'dokumen',
  'application/vnd.ms-excel': 'dokumen',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'dokumen',
  'application/vnd.ms-powerpoint': 'dokumen',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'dokumen',
  'application/vnd.oasis.opendocument.text': 'dokumen',
  'application/vnd.oasis.opendocument.spreadsheet': 'dokumen',
  'application/vnd.oasis.opendocument.presentation': 'dokumen',
  'application/rtf': 'dokumen',
  'text/plain': 'dokumen',
  'text/csv': 'dokumen',
  'text/tab-separated-values': 'dokumen',
  'application/zip': 'arsip',
  'application/x-zip-compressed': 'arsip',
  'application/x-rar-compressed': 'arsip',
  'application/vnd.rar': 'arsip',
  'application/x-7z-compressed': 'arsip',
  'application/x-tar': 'arsip',
  'application/gzip': 'arsip',
  'application/x-gzip': 'arsip',
  'application/x-bzip2': 'arsip',
};

/** Pola mime prefix → kategori. */
const MIME_PREFIX: Array<[RegExp, FileCategory]> = [
  [/^image\//, 'gambar'],
  [/^video\//, 'video'],
  [/^audio\//, 'audio'],
];

/** Ekstensi → kategori (fallback saat mime tidak dikenal). */
export const EXT_MAP: Record<string, FileCategory> = {
  jpg: 'gambar', jpeg: 'gambar', png: 'gambar', gif: 'gambar', webp: 'gambar',
  bmp: 'gambar', heic: 'gambar', heif: 'gambar', svg: 'gambar', tiff: 'gambar',
  pdf: 'dokumen', doc: 'dokumen', docx: 'dokumen', xls: 'dokumen', xlsx: 'dokumen',
  ppt: 'dokumen', pptx: 'dokumen', txt: 'dokumen', csv: 'dokumen', rtf: 'dokumen',
  odt: 'dokumen', ods: 'dokumen', odp: 'dokumen', md: 'dokumen', epub: 'dokumen',
  mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video',
  flv: 'video', m4v: 'video', '3gp': 'video',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio',
  zip: 'arsip', rar: 'arsip', '7z': 'arsip', tar: 'arsip', gz: 'arsip', bz2: 'arsip',
};

/**
 * Kelaskan file ke kategori berdasarkan mime, fallback ke ekstensi nama file.
 * Mime menang atas ekstensi bila keduanya cocok.
 */
export function classifyFile(mime: string, filename: string): ClassifiedFile {
  const m = (mime ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
  if (m) {
    const explicit = MIME_EXPLICIT[m];
    if (explicit) return { category: explicit, matchedBy: 'mime' };
    for (const [re, cat] of MIME_PREFIX) {
      if (re.test(m)) return { category: cat, matchedBy: 'mime' };
    }
  }

  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : '';
  const byExt = EXT_MAP[ext];
  if (byExt) return { category: byExt, matchedBy: 'extension' };

  return { category: 'lainnya', matchedBy: 'default' };
}
