import { memo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Download } from 'lucide-react-native';
import { usePreviewUri, type FileRow } from '../api';
import { glyphFor, tinted } from '../fileType';
import { color, font, fontSize, radius, scaleCap, space, stateColor } from '../theme';

const STATUS_LABEL: Record<string, string> = {
  indexed: 'Tercatat',
  synced: 'Sinkron',
  failed: 'Gagal',
  uploading: 'Unggah',
  pending: 'Antre',
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

/** Tile 36×36: thumbnail asli untuk gambar (dari server), glyph berwarna untuk sisanya. */
function TypeTile({ file, token, size = 36 }: { file: FileRow; token: string | null; size?: number }) {
  const glyph = glyphFor(file.ext);
  const canThumb = glyph.image && file.channelId != null && file.messageId != null;
  const [thumbFail, setThumbFail] = useState(false);
  const previewUri = usePreviewUri(file, token, canThumb);
  const box = { width: size, height: size, borderRadius: radius.control };

  if (canThumb && !thumbFail) {
    return (
      <Image
        source={{ uri: previewUri }}
        style={[box, { backgroundColor: color.surfaceAlt }]}
        onError={() => setThumbFail(true)}
        resizeMode="cover"
      />
    );
  }
  return (
    <View style={[box, styles.tile, { backgroundColor: tinted(glyph.color, 0.12), borderColor: tinted(glyph.color, 0.35) }]}>
      <glyph.Icon size={size * 0.5} strokeWidth={1.5} color={glyph.color} />
    </View>
  );
}

/**
 * Satu baris manifest: tile tipe (thumbnail/glyph), nama + meta, pill status,
 * tombol unduh. Ketuk baris → drawer detail (onPress); tekan lama → pilih massal.
 */
export const ManifestRow = memo(function ManifestRow({
  file, index, token, onPress, onDownload, selected, onLongPress,
}: {
  file: FileRow;
  index: number;
  token: string | null;
  onPress?: (file: FileRow) => void;
  onDownload?: (file: FileRow) => void;
  selected?: boolean;
  onLongPress?: (file: FileRow) => void;
}) {
  return (
    <Pressable
      onPress={() => onPress?.(file)}
      onLongPress={() => onLongPress?.(file)}
      delayLongPress={280}
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${STATUS_LABEL[file.state] ?? file.state}`}
      style={({ pressed }) => [
        styles.row,
        pressed && (onPress || onLongPress) && { backgroundColor: color.surfaceAlt },
        selected && { backgroundColor: color.primarySoft, borderColor: color.primary },
      ]}
    >
      {selected != null && (
        <View style={[styles.checkbox, selected && styles.checkboxOn]}>
          {selected && <Text style={styles.checkMark}>✓</Text>}
        </View>
      )}
      <TypeTile file={file} token={token} />
      <View style={styles.main}>
        <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
          {file.name}
        </Text>
        <Text style={styles.meta} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
          {formatSize(file.size)}  ·  {file.categoryKey}  ·  {formatDate(file.uploadedAt)}
        </Text>
      </View>
      <View style={[styles.statusPill, { backgroundColor: tinted(stateColor[file.state] ?? color.greyState, 0.12) }]}>
        <View style={[styles.statusDot, { backgroundColor: stateColor[file.state] ?? color.greyState }]} />
        <Text style={[styles.statusText, { color: stateColor[file.state] ?? color.greyState }]} maxFontSizeMultiplier={scaleCap.label}>
          {STATUS_LABEL[file.state] ?? file.state}
        </Text>
      </View>
      <Pressable
        onPress={() => onDownload?.(file)}
        hitSlop={8}
        style={({ pressed }) => [styles.dlBtn, pressed && { backgroundColor: color.surfaceAlt }]}
        accessibilityRole="button"
        accessibilityLabel={`Unduh ${file.name}`}
      >
        <Download size={16} strokeWidth={1.5} color={color.textMuted} />
      </Pressable>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(3),
    paddingVertical: space(3),
    paddingHorizontal: space(3),
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
  },
  checkbox: {
    width: 20, height: 20, borderWidth: 1.5, borderColor: color.hairline, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: color.primary, borderColor: color.primary },
  checkMark: { color: color.onPrimary, fontSize: 12, fontWeight: '700' },
  tile: { alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  main: { flex: 1, minWidth: 0 },
  name: { color: color.textPrimary, fontSize: fontSize.base, fontWeight: '600' },
  meta: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, marginTop: 2 },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space(1.5),
    borderRadius: radius.chip,
    paddingHorizontal: space(2.5),
    paddingVertical: space(1),
  },
  statusDot: { width: 5, height: 5, borderRadius: 3 },
  statusText: { fontSize: fontSize.xs, fontWeight: '600' },
  dlBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.control,
  },
});
