import { useEffect, useState } from 'react';
import {
  Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, Download, ExternalLink, FolderInput, Plus, Tag, Trash2, X } from 'lucide-react-native';
import { Api, ApiError, usePreviewUri, type CategoryRow, type FileRow } from '../api';
import { glyphFor, tinted } from '../fileType';
import { color, font, fontSize, radius, scaleCap, space, stateColor } from '../theme';

const STATUS_LABEL: Record<string, string> = {
  indexed: 'Tercatat', synced: 'Sinkron', failed: 'Gagal', uploading: 'Unggah', pending: 'Antre',
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
      <Text style={styles.metaLabel} maxFontSizeMultiplier={scaleCap.label}>{label}</Text>
      <Text style={[styles.metaValue, accent && { color: accent }]} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
        {value}
      </Text>
    </View>
  );
}

/**
 * Drawer detail file (bottom sheet): preview inline, ubah nama, tag, pindah
 * kategori, hapus. Menutup: tap backdrop / X / Esc. Semua aksi memanggil
 * server lalu onChanged() agar daftar di belakang ikut tersinkron.
 */
export function FileDrawer({
  file, token, categories, onClose, onDownload, onChanged,
}: {
  file: FileRow | null;
  token: string | null;
  categories: CategoryRow[];
  onClose: () => void;
  onDownload: (file: FileRow) => void;
  onChanged?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [showMove, setShowMove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Hook dipanggil sebelum early-return (rules of hooks): aktif hanya untuk
  // file gambar ber-channel agar tidak mengunduh file non-gambar percuma.
  const previewUri = usePreviewUri(file, token, !!file && glyphFor(file.ext).image && file.channelId != null);

  /* eslint-disable react-hooks/set-state-in-effect */
  // Sinkronkan state lokal saat file berganti (drawer dipakai ulang) — reset
  // ke nilai file saat itu. Ini sinkronisasi state↔prop, bukan render cascading.
  useEffect(() => {
    setName(file?.displayName || file?.name || '');
    setTags(file?.tags ?? []);
    setTagInput('');
    setEditingName(false);
    setShowMove(false);
    setErr(null);
  }, [file]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!file) return null;
  const glyph = glyphFor(file.ext);
  const uploaded = new Date(file.uploadedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${uploaded.getUTCFullYear()}-${pad(uploaded.getUTCMonth() + 1)}-${pad(uploaded.getUTCDate())} ${pad(uploaded.getUTCHours())}:${pad(uploaded.getUTCMinutes())} UTC`;
  const tgUrl = file.channelId != null && file.messageId != null
    ? `https://t.me/c/${file.channelId}/${file.messageId}`
    : null;

  const fail = (e: unknown) => setErr(e instanceof ApiError ? `Gagal (${e.code})` : 'Server tidak terjangkau.');

  const saveName = async () => {
    if (!name.trim()) { setErr('Nama tidak boleh kosong.'); return; }
    setBusy(true); setErr(null);
    try {
      await Api.rename(token, file.id, name.trim());
      setEditingName(false);
      onChanged?.();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const addTag = async () => {
    const t = tagInput.trim().toLowerCase();
    if (!t || tags.includes(t)) return;
    const next = [...tags, t];
    setBusy(true); setErr(null);
    try {
      const res = await Api.setTags(token, file.id, next);
      setTags(res.file.tags ?? next);
      setTagInput('');
      onChanged?.();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const removeTag = async (t: string) => {
    const next = tags.filter((x) => x !== t);
    setBusy(true); setErr(null);
    try {
      const res = await Api.setTags(token, file.id, next);
      setTags(res.file.tags ?? next);
      onChanged?.();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const moveTo = async (category: string) => {
    setBusy(true); setErr(null);
    try {
      await Api.moveFile(token, file.id, category);
      setShowMove(false);
      onChanged?.();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true); setErr(null);
    try {
      await Api.removeFile(token, file.id);
      onChanged?.();
      onClose();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Tutup detail" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, space(4)) }]}>
          <View style={styles.handle} />

          <View style={styles.head}>
            <View style={[styles.tile, { backgroundColor: tinted(glyph.color, 0.12), borderColor: tinted(glyph.color, 0.35) }]}>
              <glyph.Icon size={22} strokeWidth={1.5} color={glyph.color} />
            </View>
            <View style={styles.headMain}>
              {editingName ? (
                <TextInput
                  style={styles.nameInput}
                  value={name}
                  onChangeText={setName}
                  autoFocus
                  onSubmitEditing={() => void saveName()}
                  placeholderTextColor={color.textFaint}
                  maxFontSizeMultiplier={scaleCap.label}
                />
              ) : (
                <Text style={styles.name} numberOfLines={2} maxFontSizeMultiplier={scaleCap.title}>
                  {file.displayName || file.name}
                </Text>
              )}
              <Text style={styles.subline} maxFontSizeMultiplier={scaleCap.label}>
                {(file.ext ?? 'tanpa ekstensi').toUpperCase()} · {formatSize(file.size)} · {file.categoryKey}
              </Text>
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Tutup"
              style={({ pressed }) => [styles.closeBtn, pressed && { opacity: 0.6 }]}
            >
              <X size={18} strokeWidth={1.5} color={color.textMuted} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} bounces={false}>
            {glyph.image && file.channelId != null ? (
              <Image source={{ uri: previewUri }} style={styles.previewImg} resizeMode="contain" />
            ) : (
              <View style={styles.previewBox}>
                <glyph.Icon size={52} strokeWidth={1} color={glyph.color} />
                <Text style={styles.previewHint} maxFontSizeMultiplier={scaleCap.label}>
                  Tidak ada pratinjau — {formatSize(file.size)} siap diunduh
                </Text>
              </View>
            )}

            {/* Tag */}
            <View style={styles.block}>
              <Text style={styles.blockLabel} maxFontSizeMultiplier={scaleCap.label}>Tag</Text>
              <View style={styles.tagWrap}>
                {tags.map((t) => (
                  <Pressable
                    key={t}
                    onPress={() => void removeTag(t)}
                    accessibilityRole="button"
                    accessibilityLabel={`Hapus tag ${t}`}
                    style={styles.tagChip}
                  >
                    <Text style={styles.tagText} maxFontSizeMultiplier={scaleCap.label}>{t}</Text>
                    <X size={11} strokeWidth={2} color={color.textMuted} />
                  </Pressable>
                ))}
                <View style={styles.tagAdd}>
                  <Tag size={12} strokeWidth={1.5} color={color.textFaint} />
                  <TextInput
                    style={styles.tagInput}
                    value={tagInput}
                    onChangeText={setTagInput}
                    onSubmitEditing={() => void addTag()}
                    placeholder="tambah tag"
                    placeholderTextColor={color.textFaint}
                    autoCapitalize="none"
                    maxFontSizeMultiplier={scaleCap.label}
                  />
                  <Pressable
                    onPress={() => void addTag()}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Tambah tag"
                    style={styles.tagAddBtn}
                  >
                    <Plus size={16} strokeWidth={2} color={color.primary} />
                  </Pressable>
                </View>
              </View>
            </View>

            <View style={styles.metaBox}>
              <Meta label="Baris" value={`#${String(file.id).padStart(4, '0')}`} />
              <Meta label="Status" value={STATUS_LABEL[file.state] ?? file.state} accent={stateColor[file.state] ?? color.greyState} />
              <Meta label="Diunggah" value={dateStr} />
              <Meta label="Topik" value={file.categoryKey} />
              {file.source && <Meta label="Sumber" value={file.source} />}
              {file.channelId != null && <Meta label="Grup" value={String(file.channelId)} />}
              {file.messageId != null && <Meta label="Pesan" value={`#${file.messageId}`} />}
            </View>

            {/* Pindah kategori */}
            {showMove && (
              <View style={styles.moveBox}>
                <Text style={styles.blockLabel} maxFontSizeMultiplier={scaleCap.label}>Pindah ke lorong</Text>
                {categories.filter((c) => c.key !== file.categoryKey).map((c) => (
                  <Pressable
                    key={c.key}
                    onPress={() => void moveTo(c.key)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.moveRow, pressed && { backgroundColor: color.surfaceAlt }]}
                  >
                    <Text style={styles.moveText} maxFontSizeMultiplier={scaleCap.label}>{c.label}</Text>
                    {c.key === file.categoryKey && <Check size={16} strokeWidth={1.5} color={color.primary} />}
                  </Pressable>
                ))}
              </View>
            )}

            {err && <Text style={styles.err} maxFontSizeMultiplier={scaleCap.label}>{err}</Text>}
          </ScrollView>

          <View style={styles.actions}>
            <Pressable
              onPress={() => onDownload(file)}
              style={({ pressed }) => [styles.dlBtn, pressed && { opacity: 0.85 }]}
              accessibilityRole="button"
              accessibilityLabel={`Unduh ${file.name}`}
            >
              <Download size={16} strokeWidth={1.5} color={color.onPrimary} />
              <Text style={styles.dlText} maxFontSizeMultiplier={scaleCap.label}>Unduh</Text>
            </Pressable>
            <Pressable
              onPress={() => setEditingName(true)}
              style={({ pressed }) => [styles.secBtn, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.secText} maxFontSizeMultiplier={scaleCap.label}>Ubah nama</Text>
            </Pressable>
            <Pressable
              onPress={() => setShowMove((s) => !s)}
              accessibilityRole="button"
              accessibilityLabel="Pindah kategori"
              style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.7 }]}
            >
              <FolderInput size={16} strokeWidth={1.5} color={color.primary} />
            </Pressable>
            <Pressable
              onPress={() => void remove()}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel="Hapus file"
              style={({ pressed }) => [styles.iconBtn, styles.delBtn, busy && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}
            >
              <Trash2 size={16} strokeWidth={1.5} color={color.onPrimary} />
            </Pressable>
          </View>

          {editingName && (
            <Pressable
              onPress={() => void saveName()}
              style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]}
            >
              <Check size={16} strokeWidth={2} color={color.onPrimary} />
              <Text style={styles.saveText} maxFontSizeMultiplier={scaleCap.label}>Simpan nama</Text>
            </Pressable>
          )}

          {tgUrl && (
            <Pressable
              onPress={() => void Linking.openURL(tgUrl)}
              style={({ pressed }) => [styles.tgBtn, pressed && { opacity: 0.7 }]}
            >
              <ExternalLink size={14} strokeWidth={1.5} color={color.primary} />
              <Text style={styles.tgText} maxFontSizeMultiplier={scaleCap.label}>Buka di Telegram</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet,
    maxHeight: '90%', minHeight: 360,
    paddingHorizontal: space(4), paddingTop: space(2),
  },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: color.hairline, marginBottom: space(3) },
  head: {
    flexDirection: 'row', alignItems: 'center', gap: space(3),
    paddingBottom: space(3), borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  tile: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: radius.control },
  headMain: { flex: 1, minWidth: 0 },
  name: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: '600' },
  nameInput: {
    borderWidth: 1, borderColor: color.primary, borderRadius: radius.control, backgroundColor: color.surface,
    color: color.textPrimary, paddingHorizontal: space(2.5), paddingVertical: space(2), fontSize: fontSize.md,
  },
  subline: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, marginTop: 2 },
  closeBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.control,
  },
  body: { flexGrow: 0 },
  previewImg: { height: 220, marginTop: space(3), backgroundColor: color.base, borderRadius: radius.control },
  previewBox: {
    marginTop: space(3), height: 160, alignItems: 'center', justifyContent: 'center', gap: space(3),
    backgroundColor: color.base, borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
  },
  previewHint: { fontSize: fontSize.xs, color: color.textFaint, textAlign: 'center', paddingHorizontal: space(4) },
  block: { marginTop: space(4) },
  blockLabel: { fontSize: fontSize.sm, fontWeight: '600', color: color.textMuted, marginBottom: space(2) },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), alignItems: 'center' },
  tagChip: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.chip,
    backgroundColor: color.surfaceAlt,
    paddingHorizontal: space(3), minHeight: 32,
  },
  tagText: { fontSize: fontSize.xs, color: color.textPrimary },
  tagAdd: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.chip,
    backgroundColor: color.surface,
    paddingLeft: space(3), paddingRight: space(1), minHeight: 36, minWidth: 130,
  },
  tagInput: { fontSize: fontSize.xs, color: color.textPrimary, minWidth: 70, padding: 0 },
  tagAddBtn: { width: 32, height: 36, alignItems: 'center', justifyContent: 'center' },
  metaBox: {
    marginTop: space(4), borderWidth: 1, borderColor: color.hairline,
    borderRadius: radius.control, overflow: 'hidden',
  },
  metaRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(3), paddingVertical: space(2.5),
    borderBottomWidth: 1, borderBottomColor: color.hairline, gap: space(4),
  },
  metaLabel: { fontSize: fontSize.xs, color: color.textFaint },
  metaValue: { fontSize: fontSize.xs, color: color.textPrimary, flexShrink: 1, textAlign: 'right', fontWeight: '600' },
  moveBox: {
    marginTop: space(4), borderWidth: 1, borderColor: color.hairline,
    borderRadius: radius.control, overflow: 'hidden',
  },
  moveRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(3), minHeight: 48,
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  moveText: { color: color.textPrimary, fontSize: fontSize.sm },
  err: { color: color.red, fontSize: fontSize.xs, marginTop: space(3) },
  actions: { flexDirection: 'row', gap: space(2), paddingTop: space(3), alignItems: 'center' },
  dlBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.primary, borderRadius: radius.container, minHeight: 48,
  },
  dlText: { color: color.onPrimary, fontWeight: '700', fontSize: fontSize.sm },
  secBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.container,
    backgroundColor: color.surface, minHeight: 48, paddingHorizontal: space(4),
  },
  secText: { color: color.textMuted, fontSize: fontSize.sm, fontWeight: '600' },
  iconBtn: {
    width: 48, height: 48, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.container, borderWidth: 1, borderColor: color.hairline,
    backgroundColor: color.surface,
  },
  delBtn: { backgroundColor: color.red, borderColor: color.red },
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.green, borderRadius: radius.container, minHeight: 48, marginTop: space(2),
  },
  saveText: { color: color.onPrimary, fontWeight: '700', fontSize: fontSize.sm },
  tgBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.container,
    backgroundColor: color.surface, paddingVertical: space(3), marginTop: space(2), minHeight: 44,
  },
  tgText: { color: color.primary, fontSize: fontSize.xs, fontWeight: '600' },
});
