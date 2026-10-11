import { Image, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Download, ExternalLink, X } from 'lucide-react-native';
import { fileDownloadUrl, type FileRow } from '../api';
import { glyphFor, tinted } from '../fileType';
import { color, font, fontSize, radius, space, stateColor } from '../theme';

const STATUS_LABEL: Record<string, string> = {
  indexed: 'TERCATAT', synced: 'SINKRON', failed: 'GAGAL', uploading: 'UNGGAH', pending: 'ANTRE',
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function Meta({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={[styles.metaValue, accent && { color: accent }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

/**
 * Drawer detail file (bottom sheet): preview, metadata manifest, aksi unduh
 * dan buka pesan asli di Telegram. Menutup: tap backdrop / tombol X / Esc.
 */
export function FileDrawer({
  file, token, onClose, onDownload,
}: {
  file: FileRow | null;
  token: string | null;
  onClose: () => void;
  onDownload: (file: FileRow) => void;
}) {
  if (!file) return null;
  const glyph = glyphFor(file.ext);
  const uploaded = new Date(file.uploadedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${uploaded.getUTCFullYear()}-${pad(uploaded.getUTCMonth() + 1)}-${pad(uploaded.getUTCDate())} ${pad(uploaded.getUTCHours())}:${pad(uploaded.getUTCMinutes())} UTC`;
  const tgUrl = file.channelId != null && file.messageId != null
    ? `https://t.me/c/${file.channelId}/${file.messageId}`
    : null;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Tutup detail" />
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.head}>
            <View style={[styles.tile, { backgroundColor: tinted(glyph.color, 0.12), borderColor: tinted(glyph.color, 0.35) }]}>
              <glyph.Icon size={22} strokeWidth={1.5} color={glyph.color} />
            </View>
            <View style={styles.headMain}>
              <Text style={styles.name} numberOfLines={2}>{file.name}</Text>
              <Text style={styles.subline}>
                {(file.ext ?? 'tanpa ekstensi').toUpperCase()} · {formatSize(file.size)} · {file.categoryKey.toUpperCase()}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}>
              <X size={16} strokeWidth={1.5} color={color.textMuted} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} bounces={false}>
            {glyph.image && file.channelId != null ? (
              <Image source={{ uri: fileDownloadUrl(file, token) }} style={styles.previewImg} resizeMode="contain" />
            ) : (
              <View style={styles.previewBox}>
                <glyph.Icon size={56} strokeWidth={1} color={glyph.color} />
                <Text style={styles.previewHint}>TIDAK ADA PRATINJAU — {formatSize(file.size)} SIAP DIUNDUH</Text>
              </View>
            )}

            <View style={styles.metaBox}>
              <Meta label="BARIS" value={`#${String(file.id).padStart(4, '0')}`} />
              <Meta label="STATUS" value={STATUS_LABEL[file.state] ?? file.state.toUpperCase()} accent={stateColor[file.state] ?? color.greyState} />
              <Meta label="DIUNGGAH" value={dateStr} />
              <Meta label="TOPIK" value={file.categoryKey.toUpperCase()} />
              {file.channelId != null && (
                <Meta label="GRUP" value={String(file.channelId)} />
              )}
              {file.messageId != null && (
                <Meta label="PESAN" value={`#${file.messageId}`} />
              )}
            </View>
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              onPress={() => onDownload(file)}
              style={({ pressed }) => [styles.dlBtn, pressed && { opacity: 0.85 }]}
              accessibilityLabel={`Unduh ${file.name}`}
            >
              <Download size={16} strokeWidth={1.5} color={color.base} />
              <Text style={styles.dlText}>UNDUH</Text>
            </Pressable>
            {tgUrl && (
              <Pressable
                onPress={() => void Linking.openURL(tgUrl)}
                style={({ pressed }) => [styles.tgBtn, pressed && { opacity: 0.7 }]}
              >
                <ExternalLink size={16} strokeWidth={1.5} color={color.amber} />
                <Text style={styles.tgText}>TELEGRAM</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: color.surface,
    borderTopWidth: 1, borderTopColor: color.hairline,
    maxHeight: '85%', minHeight: 340,
    paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(5),
  },
  handle: {
    alignSelf: 'center', width: 36, height: 3, borderRadius: 2,
    backgroundColor: color.hairline, marginBottom: space(3),
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingBottom: space(3), borderBottomWidth: 1, borderBottomColor: color.hairline },
  tile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: radius.control },
  headMain: { flex: 1, minWidth: 0 },
  name: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: '600' },
  subline: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 0.5, marginTop: 2 },
  closeBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control },
  body: { flexGrow: 0 },
  previewImg: { height: 240, marginTop: space(3), backgroundColor: color.base },
  previewBox: {
    marginTop: space(3), height: 180, alignItems: 'center', justifyContent: 'center', gap: space(3),
    backgroundColor: color.base, borderWidth: 1, borderColor: color.hairline,
  },
  previewHint: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1 },
  metaBox: { marginTop: space(3), borderWidth: 1, borderColor: color.hairline },
  metaRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(3), paddingVertical: space(2.5),
    borderBottomWidth: 1, borderBottomColor: color.hairline, gap: space(4),
  },
  metaLabel: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1 },
  metaValue: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textPrimary, flexShrink: 1, textAlign: 'right' },
  actions: { flexDirection: 'row', gap: space(2), paddingTop: space(3) },
  dlBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(3),
  },
  dlText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  tgBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    borderWidth: 1, borderColor: color.amberDim, borderRadius: radius.control,
    paddingVertical: space(3), paddingHorizontal: space(4),
  },
  tgText: { color: color.amber, fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1 },
});
