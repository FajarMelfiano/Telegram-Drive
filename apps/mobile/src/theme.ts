import { Platform } from 'react-native';

/**
 * Design tokens v3 — "modern light teal" (mengikuti referensi dashboard user).
 * - Latar terang, kartu putih dengan bayangan lembut, satu aksen teal.
 * - Hierarki: base -> surface -> surfaceAlt + hairline; bayangan hanya untuk
 *   elemen terangkat sungguhan (kartu, nav pill, FAB, sheet).
 * - Kontras terukur di atas putih: teks ~16:1, muted ~8:1, faint ~5:1, teal ~5.5:1.
 * - Sans sistem untuk semua peran; mono hanya kredensial & angka tabular.
 */
export const color = {
  base: '#F4F6F8',        // latar aplikasi
  surface: '#FFFFFF',      // kartu
  surfaceAlt: '#EAEFF1',   // tekan / isian halus
  hairline: '#E2E8EA',     // garis 1px
  textPrimary: '#13211E',
  textMuted: '#4F5D59',
  textFaint: '#66736F',
  primary: '#0F766E',      // teal — CTA, header, nav, FAB
  primaryDark: '#0B5E57',  // tekan
  primarySoft: '#DCF3EC',  // tint lembut (chip aktif, alas ikon)
  onPrimary: '#FFFFFF',
  amber: '#E8A33D',        // status: mengunggah / antre jingga
  amberDim: '#FBF1DD',
  green: '#2E8B60',        // siap / tersinkron
  red: '#D24A40',          // gagal / berbahaya
  redDim: '#FAE7E4',
  greyState: '#8A9490',    // antre / pending
  scrim: 'rgba(15, 30, 27, 0.45)',
} as const;

/** Bayangan lembut (referensi kartu putih melayang). */
export const shadow = {
  card: Platform.select({
    ios: {
      shadowColor: '#0F2420', shadowOpacity: 0.06, shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    },
    android: { elevation: 2 },
    default: {},
  }) as object,
  float: Platform.select({
    ios: {
      shadowColor: '#0F2420', shadowOpacity: 0.16, shadowRadius: 20,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: 8 },
    default: {},
  }) as object,
} as const;

export const space = (n: number): number => n * 4;

export const radius = { control: 10, container: 14, card: 16, chip: 999, sheet: 22, fab: 28 } as const;

export const fontSize = { xs: 12, sm: 13, base: 15, md: 17, lg: 20, xl: 26, xxl: 32 } as const;

export const font = {
  sans: Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui, sans-serif' }) as string,
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' }) as string,
} as const;

/** Target sentuh minimum (dp) — semua kontrol interaktif. */
export const hit = { min: 44 } as const;

/** Batas scaling teks agar judul/label tidak tumpang tindih saat font sistem besar. */
export const scaleCap = { title: 1.3, label: 1.4 } as const;

/** Breakpoint layout (mobile-first). */
export const layout = { compact: 360, railWidth: 208, maxContent: 720 } as const;

export const stateColor: Record<string, string> = {
  indexed: color.primary,
  synced: color.green,
  failed: color.red,
  uploading: color.amber,
  pending: color.greyState,
};
