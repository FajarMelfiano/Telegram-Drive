import { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { FileRow } from '../api';
import { color, font, fontSize, radius, space, stateColor } from '../theme';

const STATUS_LABEL: Record<string, string> = {
  indexed: 'TERCATAT',
  synced: 'SINKRON',
  failed: 'GAGAL',
  uploading: 'UNGGAH',
  pending: 'ANTRE',
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Satu baris manifest: nomor urut mono, lencana ekstensi, nama, ukuran, tanggal, status. */
export const ManifestRow = memo(function ManifestRow({ file, index }: { file: FileRow; index: number }) {
  return (
    <View style={styles.row}>
      <Text style={styles.index} numberOfLines={1}>
        {String(index + 1).padStart(4, '0')}
      </Text>
      <View style={styles.extBadge}>
        <Text style={styles.extText}>{(file.ext ?? '—').slice(0, 4).toUpperCase()}</Text>
      </View>
      <View style={styles.main}>
        <Text style={styles.name} numberOfLines={1}>
          {file.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1}>
          {formatSize(file.size)}  ·  {file.categoryKey.toUpperCase()}  ·  {formatDate(file.uploadedAt)}
        </Text>
      </View>
      <View style={[styles.statusPill, { borderColor: stateColor[file.state] ?? color.greyState }]}>
        <View style={[styles.statusDot, { backgroundColor: stateColor[file.state] ?? color.greyState }]} />
        <Text style={[styles.statusText, { color: stateColor[file.state] ?? color.greyState }]}>
          {STATUS_LABEL[file.state] ?? file.state.toUpperCase()}
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(3),
    paddingHorizontal: space(4),
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  index: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, width: 34 },
  extBadge: {
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.control,
    paddingHorizontal: space(1.5),
    paddingVertical: space(0.5),
  },
  extText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textMuted, letterSpacing: 0.5 },
  main: { flex: 1, minWidth: 0 },
  name: { color: color.textPrimary, fontSize: fontSize.base },
  meta: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, marginTop: 2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    borderWidth: 1,
    borderRadius: radius.chip,
    paddingHorizontal: space(2),
    paddingVertical: space(1),
  },
  statusDot: { width: 5, height: 5, borderRadius: 3 },
  statusText: { fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 0.5 },
});
