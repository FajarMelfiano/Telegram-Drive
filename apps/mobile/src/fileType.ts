import { File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileText, Film, Music } from 'lucide-react-native';
import { color } from './theme';

/** Glyph per tipe file: ikon lucide + warna keluarga, semua dari palet tema. */
export interface Glyph {
  Icon: typeof File;
  color: string;
  /** true bila file ini gambar (layak menampilkan thumbnail). */
  image: boolean;
}

const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'svg']);
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', '3gp']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac']);
const SHEET = new Set(['xlsx', 'xls', 'csv', 'ods', 'tsv']);
const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz']);
const CODE = new Set(['js', 'ts', 'tsx', 'jsx', 'json', 'html', 'css', 'py', 'java', 'go', 'rs', 'sh', 'xml', 'yml', 'yaml', 'sql']);
const DOC = new Set(['doc', 'docx', 'odt', 'rtf', 'txt', 'ppt', 'pptx', 'odp']);

/**
 * Palet fungsional (bukan warna baru): merah = pdf, hijau = gambar/lembar bentang,
 * amber = video/kode, putih = audio, abu = arsip, muted = dokumen teks.
 */
export function glyphFor(ext: string | null): Glyph {
  const e = (ext ?? '').toLowerCase();
  if (IMAGE.has(e)) return { Icon: FileImage, color: color.green, image: true };
  if (VIDEO.has(e)) return { Icon: Film, color: color.amber, image: false };
  if (AUDIO.has(e)) return { Icon: Music, color: color.textPrimary, image: false };
  if (e === 'pdf') return { Icon: FileText, color: color.red, image: false };
  if (SHEET.has(e)) return { Icon: FileSpreadsheet, color: color.green, image: false };
  if (ARCHIVE.has(e)) return { Icon: FileArchive, color: color.greyState, image: false };
  if (CODE.has(e)) return { Icon: FileCode, color: color.amber, image: false };
  if (DOC.has(e)) return { Icon: FileText, color: color.textMuted, image: false };
  return { Icon: File, color: color.textFaint, image: false };
}

/** Hex + alpha (0..1) — untuk latar tile ikon tanpa menambah warna palette. */
export function tinted(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
