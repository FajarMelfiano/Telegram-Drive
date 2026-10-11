/** Tipe bersama untuk server & aplikasi. */

export type FileCategory =
  | 'gambar'
  | 'dokumen'
  | 'video'
  | 'audio'
  | 'arsip'
  | 'lainnya';

/** Label tampilan per kategori (dipakai judul channel: `Drive · <label>`). */
export const CATEGORY_LABELS: Record<FileCategory, string> = {
  gambar: 'Gambar',
  dokumen: 'Dokumen',
  video: 'Video',
  audio: 'Audio',
  arsip: 'Arsip',
  lainnya: 'Lainnya',
};

export type FileState = 'pending' | 'uploading' | 'indexed' | 'synced' | 'failed';

/** Hasil parser query pencarian (rule-based, id + en). */
export interface ParsedQuery {
  text: string;
  ext: string | null;
  category: FileCategory | null;
  dateFrom: string | null;
  dateTo: string | null;
  minSize: number | null;
}

/** Hasil klasifikasi file berdasarkan mime/ext. */
export interface ClassifiedFile {
  category: FileCategory;
  matchedBy: 'mime' | 'extension' | 'default';
}
