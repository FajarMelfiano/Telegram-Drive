import type { FileCategory, ParsedQuery } from './types.js';
import { EXT_MAP } from './classify.js';

/** Ekstensi yang dikenali parser (kata tanpa titik juga dianggap ekstensi). */
const KNOWN_EXTS = new Set(Object.keys(EXT_MAP));

/** Kata kunci kategori (id + en). Hanya dipakai bila query TIDAK punya ekstensi. */
const CATEGORY_KEYWORDS: Record<string, FileCategory> = {
  gambar: 'gambar', foto: 'gambar', image: 'gambar', images: 'gambar',
  photo: 'gambar', photos: 'gambar', picture: 'gambar', pictures: 'gambar',
  dokumen: 'dokumen', document: 'dokumen', documents: 'dokumen',
  video: 'video', videos: 'video', film: 'video',
  audio: 'audio', musik: 'audio', music: 'audio', lagu: 'audio',
  arsip: 'arsip', archive: 'arsip', archives: 'arsip',
};

/** Nama bulan (id + en) → indeks 0-11. */
const MONTHS: Record<string, number> = {
  januari: 0, january: 0, jan: 0,
  februari: 1, february: 1, feb: 1,
  maret: 2, march: 2, mar: 2,
  april: 3, apr: 3,
  mei: 4, may: 4,
  juni: 5, june: 5, jun: 5,
  juli: 6, july: 6, jul: 6,
  agustus: 7, august: 7, agu: 7,
  september: 8, sep: 8,
  oktober: 9, october: 9, okt: 9, oct: 9,
  november: 10, nopember: 10, nov: 10,
  desember: 11, december: 11, des: 11, dec: 11,
};

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 ** 2,
  gb: 1024 ** 3,
};

const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const endOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 23, 59, 59, 999));
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));

/** Frasa relatif id+en. Urutan penting: yang panjang dulu. */
const RELATIVE: Array<{ words: string[]; range: (ref: Date) => [Date, Date] }> = [
  { words: ['hari ini', 'today'], range: (d) => [startOfDay(d), endOfDay(d)] },
  { words: ['kemarin', 'yesterday'], range: (d) => { const x = addDays(startOfDay(d), -1); return [x, endOfDay(x)]; } },
  // "minggu lalu" = 7 hari berakhir kemarin (deterministik, tanpa ambiguitas awal pekan)
  { words: ['minggu lalu', 'last week'], range: (d) => [addDays(startOfDay(d), -7), addDays(endOfDay(d), -1)] },
  { words: ['minggu ini', 'this week'], range: (d) => [addDays(startOfDay(d), -((d.getUTCDay() + 6) % 7)), endOfDay(d)] },
  { words: ['bulan lalu', 'last month'], range: (d) => { const m = addMonths(d, -1); return [startOfMonth(m), endOfMonth(m)]; } },
  { words: ['bulan ini', 'this month'], range: (d) => [startOfMonth(d), endOfDay(d)] },
];

const SIZE_RE = /^([<>]=?)(\d+(?:\.\d+)?)(b|kb|mb|gb)$/i;
const ISO_DATE_RE = /^([<>]=?)?(\d{4})-(\d{2})(?:-(\d{2}))?$/;
const YEAR_RE = /^\d{4}$/;

const MONTH_RANGE = (ref: Date, month: number, year?: number): [Date, Date] => {
  const y = year ?? ref.getUTCFullYear();
  return [new Date(Date.UTC(y, month, 1)), new Date(Date.UTC(y, month + 1, 0, 23, 59, 59, 999))];
};

const EMPTY: ParsedQuery = {
  text: '', ext: null, category: null, dateFrom: null, dateTo: null, minSize: null,
};

/**
 * Parser rule-based untuk query pencarian (bahasa Indonesia + Inggris).
 * Mendukung: ekstensi (`.pdf` / `pdf`), kategori (`gambar`/`foto`/...),
 * bulan (`juni`, `juni 2025`), tanggal relatif (`kemarin`, `bulan lalu`),
 * tanggal eksplisit (`2025-06-15`, `2025-06`, `>2025-06-01`), dan ukuran (`>100mb`).
 * Sisa token jadi teks pencarian. Tidak pernah melempar error.
 *
 * Aturan kategori: kata kategori hanya jadi filter bila query TANPA ekstensi
 * (`.png foto liburan` → teks; `foto kemarin` → kategori gambar).
 */
export function parseQuery(input: string, ref: Date = new Date()): ParsedQuery {
  let s = (input ?? '').toLowerCase().trim();
  if (!s) return { ...EMPTY };

  const froms: number[] = [];
  const tos: number[] = [];
  let ext: string | null = null;
  let minSize: number | null = null;

  // 1) Frasa relatif — hilangkan dari string, catat rentangnya
  for (const { words, range } of RELATIVE) {
    for (const w of words) {
      const re = new RegExp(`(?:^|\\s)${w.replace(/ /g, '\\s+')}(?=\\s|$)`, 'g');
      if (re.test(s)) {
        const [a, b] = range(ref);
        froms.push(a.getTime());
        tos.push(b.getTime());
        s = s.replace(re, ' ');
      }
    }
  }
  s = s.replace(/\s+/g, ' ').trim();

  // 2) Tokenisasi
  const tokens = s.split(' ').filter(Boolean);
  const rest: string[] = [];
  let monthSeen = false;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // Ukuran: >100mb / >=1gb (hanya operator '>' yang didukung v1)
    const size = SIZE_RE.exec(tok);
    if (size) {
      if (size[1]!.startsWith('>')) {
        minSize = Math.round(parseFloat(size[2]!) * SIZE_UNITS[size[3]!.toLowerCase()]!);
      }
      continue; // '<…' diabaikan dengan anggun
    }

    // Tanggal ISO: 2025-06-15 / >2025-06-01 / 2025-06
    const iso = ISO_DATE_RE.exec(tok);
    if (iso) {
      const [, op, y, m, d] = iso;
      const year = parseInt(y!, 10);
      const month = parseInt(m!, 10) - 1;
      if (d) {
        const day = new Date(Date.UTC(year, month, parseInt(d, 10)));
        if (op === '>') froms.push(startOfDay(day).getTime());
        else if (op === '<') tos.push(endOfDay(day).getTime());
        else { froms.push(startOfDay(day).getTime()); tos.push(endOfDay(day).getTime()); }
      } else {
        const [a, b] = MONTH_RANGE(ref, month, year);
        froms.push(a.getTime());
        tos.push(b.getTime());
      }
      monthSeen = true;
      continue;
    }

    // Nama bulan, opsional diikuti tahun
    if (MONTHS[tok] !== undefined) {
      const month = MONTHS[tok]!;
      let year: number | undefined;
      const next = tokens[i + 1];
      if (next && YEAR_RE.test(next)) {
        year = parseInt(next, 10);
      }
      const [a, b] = MONTH_RANGE(ref, month, year);
      froms.push(a.getTime());
      tos.push(b.getTime());
      monthSeen = true;
      continue;
    }
    if (YEAR_RE.test(tok) && monthSeen) continue; // tahun sudah dipakai bulan sebelumnya

    // Tahun tunggal → rentang setahun
    if (YEAR_RE.test(tok)) {
      const y = parseInt(tok, 10);
      if (y >= 1990 && y <= 2100) {
        froms.push(Date.UTC(y, 0, 1));
        tos.push(Date.UTC(y, 11, 31, 23, 59, 59, 999));
        continue;
      }
    }

    // Ekstensi: `.pdf` atau kata ekstensi dikenal. Yang pertama menang, sisanya teks.
    const bare = tok.startsWith('.') ? tok.slice(1) : tok;
    if (!ext && bare && KNOWN_EXTS.has(bare)) {
      ext = bare;
      continue;
    }
    // Pengulangan ekstensi (`.pdf` setelah `pdf`) → masuk teks tanpa titik
    if (ext && bare !== tok && KNOWN_EXTS.has(bare)) {
      rest.push(bare);
      continue;
    }

    rest.push(tok);
  }

  // 3) Kategori — hanya bila tidak ada ekstensi; kata kategori pertama yang dikonsumsi
  let category: FileCategory | null = null;
  const textTokens: string[] = [];
  if (!ext) {
    for (const tok of rest) {
      if (!category && CATEGORY_KEYWORDS[tok]) {
        category = CATEGORY_KEYWORDS[tok]!;
        continue;
      }
      textTokens.push(tok);
    }
  } else {
    textTokens.push(...rest);
  }

  // 4) Gabungkan rentang tanggal: dari = paling akhir, sampai = paling awal
  const dateFrom = froms.length ? new Date(Math.max(...froms)).toISOString() : null;
  const dateTo = tos.length ? new Date(Math.min(...tos)).toISOString() : null;

  return {
    text: textTokens.join(' '),
    ext,
    category,
    dateFrom: dateFrom && dateTo && dateFrom > dateTo ? null : dateFrom,
    dateTo: dateFrom && dateTo && dateFrom > dateTo ? null : dateTo,
    minSize,
  };
}
