import { Platform } from 'react-native';

/**
 * Design tokens — "manifest gudang di terminal gelap".
 * Aturan bentuk (didokumentasikan): kontainer radius 0 (hairline grid),
 * kontrol radius 4px, chip status pill.
 */
export const color = {
  base: '#0B0C0E',        // near-black (bukan #000)
  surface: '#131518',     // panel
  surfaceAlt: '#191C20',  // baris terangkat / tekan
  hairline: '#24272C',    // garis 1px
  textPrimary: '#E8E9EB',
  textMuted: '#8B9096',
  textFaint: '#5C6167',
  amber: '#E8A33D',       // satu aksen: label kuning gudang
  amberDim: '#7A5620',
  green: '#5BB98B',       // siap / tersinkron
  red: '#D9634C',         // gagal
  greyState: '#6B7076',   // antre / pending
} as const;

export const space = (n: number): number => n * 4;

export const radius = { control: 4, container: 0, chip: 999 } as const;

export const fontSize = { xs: 11, sm: 12, base: 14, md: 16, lg: 20, xl: 24, xxl: 30 } as const;

export const font = {
  mono: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'ui-monospace, Menlo, monospace' }) as string,
  sans: Platform.select({ ios: 'Helvetica Neue', android: 'sans-serif', default: 'system-ui, sans-serif' }) as string,
} as const;

export const stateColor: Record<string, string> = {
  indexed: color.amber,
  synced: color.green,
  failed: color.red,
  uploading: color.amber,
  pending: color.greyState,
};
