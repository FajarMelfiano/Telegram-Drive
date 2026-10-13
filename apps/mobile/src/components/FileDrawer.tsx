import { useEffect, useState } from 'react';
import {
  Image, KeyboardAvoidingView, Linking, Modal, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Check, Download, ExternalLink, FolderInput, Plus, Tag, Trash2, X } from 'lucide-react-native';
import { Api, ApiError, usePreviewUri, type CategoryRow, type FileRow } from '../api';
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
 * Drawer detail file v2 (bottom sheet) — "like a drive app": preview inline,
 * ubah nama, tag, pindah kategori, hapus. Menutup: tap backdrop / X / Esc.
 * Semua aksi memanggil server lalu memanggil onDeleted/onUpdated agar daftar
 * di belakang ikut tersinkron.
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
        <View style={styles.sheet}>
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
                />
              ) : (
                <Text style={styles.name} numberOfLines={2}>{file.displayName || file.name}</Text>
              )}
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
              <Image source={{ uri: previewUri }} style={styles.previewImg} resizeMode="contain" />
            ) : (
              <View style={styles.previewBox}>
                <glyph.Icon size={56} strokeWidth={1} color={glyph.color} />
                <Text style={styles.previewHint}>TIDAK ADA PRATINJAU — {formatSize(file.size)} SIAP DIUNDUH</Text>
              </View>
            )}

            {/* Tag */}
            <View style={styles.block}>
              <Text style={styles.blockLabel}>TAG</Text>
              <View style={styles.tagWrap}>
                {tags.map((t) => (
                  <Pressable key={t} onPress={() => void removeTag(t)} style={styles.tagChip}>
                    <Text style={styles.tagText}>{t}</Text>
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
                  />
                  <Pressable onPress={() => void addTag()} hitSlop={6}>
                    <Plus size={14} strokeWidth={2} color={color.amber} />
                  </Pressable>
                </View>
              </View>
            </View>

            <View style={styles.metaBox}>
              <Meta label="BARIS" value={`#${String(file.id).padStart(4, '0')}`} />
              <Meta label="STATUS" value={STATUS_LABEL[file.state] ?? file.state.toUpperCase()} accent={stateColor[file.state] ?? color.greyState} />
              <Meta label="DIUNGGAH" value={dateStr} />
              <Meta label="TOPIK" value={file.categoryKey.toUpperCase()} />
              {file.source && <Meta label="SUMBER" value={file.source.toUpperCase()} />}
              {file.channelId != null && <Meta label="GRUP" value={String(file.channelId)} />}
              {file.messageId != null && <Meta label="PESAN" value={`#${file.messageId}`} />}
            </View>

            {/* Pindah kategori */}
            {showMove && (
              <View style={styles.moveBox}>
                <Text style={styles.blockLabel}>PINDAH KE LORONG</Text>
                {categories.filter((c) => c.key !== file.categoryKey).map((c) => (
                  <Pressable key={c.key} onPress={() => void moveTo(c.key)} style={({ pressed }) => [styles.moveRow, pressed && { backgroundColor: color.surfaceAlt }]}>
                    <Text style={styles.moveText}>{c.label}</Text>
                    {c.key === file.categoryKey && <Check size={14} strokeWidth={1.5} color={color.amber} />}
                  </Pressable>
                ))}
              </View>
            )}

            {err && <Text style={styles.err}>{err}</Text>}
          </ScrollView>

          <View style={styles.actions}>
            <Pressable onPress={() => onDownload(file)} style={({ pressed }) => [styles.dlBtn, pressed && { opacity: 0.85 }]} accessibilityLabel={`Unduh ${file.name}`}>
              <Download size={16} strokeWidth={1.5} color={color.base} />
              <Text style={styles.dlText}>UNDUH</Text>
            </Pressable>
            <Pressable onPress={() => setEditingName(true)} style={({ pressed }) => [styles.secBtn, pressed && { opacity: 0.7 }]}>
              <Text style={styles.secText}>UBAH NAMA</Text>
            </Pressable>
            <Pressable onPress={() => setShowMove((s) => !s)} style={({ pressed }) => [styles.secBtn, pressed && { opacity: 0.7 }]}>
              <FolderInput size={15} strokeWidth={1.5} color={color.amber} />
            </Pressable>
            <Pressable onPress={() => void remove()} disabled={busy} style={({ pressed }) => [styles.delBtn, busy && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
              <Trash2 size={16} strokeWidth={1.5} color={color.base} />
            </Pressable>
          </View>

          {editingName && (
            <Pressable onPress={() => void saveName()} style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]}>
              <Check size={16} strokeWidth={2} color={color.base} />
              <Text style={styles.saveText}>SIMPAN NAMA</Text>
            </Pressable>
          )}

          {tgUrl && (
            <Pressable onPress={() => void Linking.openURL(tgUrl)} style={({ pressed }) => [styles.tgBtn, pressed && { opacity: 0.7 }]}>
              <ExternalLink size={14} strokeWidth={1.5} color={color.amber} />
              <Text style={styles.tgText}>BUKA DI TELEGRAM</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  sheet: {
    backgroundColor: color.surface,
    borderTopWidth: 1, borderTopColor: color.hairline,
    maxHeight: '90%', minHeight: 360,
    paddingHorizontal: space(4), paddingTop: space(2), paddingBottom: space(5),
  },
  handle: { alignSelf: 'center', width: 36, height: 3, borderRadius: 2, backgroundColor: color.hairline, marginBottom: space(3) },
  head: { flexDirection: 'row', alignItems: 'center', gap: space(3), paddingBottom: space(3), borderBottomWidth: 1, borderBottomColor: color.hairline },
  tile: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: radius.control },
  headMain: { flex: 1, minWidth: 0 },
  name: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: '600' },
  nameInput: {
    borderWidth: 1, borderColor: color.amberDim, borderRadius: radius.control, backgroundColor: color.base,
    color: color.textPrimary, paddingHorizontal: space(2), paddingVertical: space(1.5), fontSize: fontSize.md,
  },
  subline: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 0.5, marginTop: 2 },
  closeBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control },
  body: { flexGrow: 0 },
  previewImg: { height: 220, marginTop: space(3), backgroundColor: color.base },
  previewBox: { marginTop: space(3), height: 160, alignItems: 'center', justifyContent: 'center', gap: space(3), backgroundColor: color.base, borderWidth: 1, borderColor: color.hairline },
  previewHint: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1 },
  block: { marginTop: space(3) },
  blockLabel: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1, marginBottom: space(2) },
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), alignItems: 'center' },
  tagChip: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.chip,
    paddingHorizontal: space(2.5), paddingVertical: space(1),
  },
  tagText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textPrimary },
  tagAdd: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.chip,
    paddingHorizontal: space(2.5), paddingVertical: space(1), minWidth: 120,
  },
  tagInput: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textPrimary, minWidth: 70, padding: 0 },
  metaBox: { marginTop: space(3), borderWidth: 1, borderColor: color.hairline },
  metaRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(3), paddingVertical: space(2.5),
    borderBottomWidth: 1, borderBottomColor: color.hairline, gap: space(4),
  },
  metaLabel: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1 },
  metaValue: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textPrimary, flexShrink: 1, textAlign: 'right' },
  moveBox: { marginTop: space(3), borderWidth: 1, borderColor: color.hairline },
  moveRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(3), paddingVertical: space(3),
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  moveText: { color: color.textPrimary, fontSize: fontSize.sm },
  err: { color: color.red, fontSize: fontSize.xs, fontFamily: font.mono, marginTop: space(3) },
  actions: { flexDirection: 'row', gap: space(2), paddingTop: space(3), alignItems: 'center' },
  dlBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(3),
  },
  dlText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  secBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    paddingVertical: space(3), paddingHorizontal: space(3),
  },
  secText: { color: color.textMuted, fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1 },
  delBtn: {
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: color.red, borderRadius: radius.control, paddingVertical: space(3), paddingHorizontal: space(3),
  },
  saveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    backgroundColor: color.green, borderRadius: radius.control, paddingVertical: space(3), marginTop: space(2),
  },
  saveText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  tgBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space(2),
    borderWidth: 1, borderColor: color.amberDim, borderRadius: radius.control,
    paddingVertical: space(2.5), marginTop: space(2),
  },
  tgText: { color: color.amber, fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1 },
});
