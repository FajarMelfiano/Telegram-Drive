import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Modal, Platform, Pressable, RefreshControl, StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { Inbox, RefreshCw, Upload } from 'lucide-react-native';
import { Api, ApiError, downloadFile, type CategoryRow, type FileRow } from '../api';
import { ManifestRow } from '../components/ManifestRow';
import { CategoryRail } from '../components/CategoryRail';
import { FileDrawer } from '../components/FileDrawer';
import {
  drainQueue, enqueueUpload, getQueue, removeUpload, retryUpload, type QueueEntry,
} from '../uploadQueue';
import { color, font, fontSize, radius, space } from '../theme';

/**
 * Manifest — layar utama: rail lorong kategori + daftar baris file
 * + unggah pintar + status sinkron.
 */
export function ManifestScreen({ token, me, onLogout }: { token: string; me: string; onLogout: () => void }) {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sync, setSync] = useState<{ pending: number; sent: number } | null>(null);
  const [drawer, setDrawer] = useState<FileRow | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [batchBusy, setBatchBusy] = useState(false);
  const [movePicker, setMovePicker] = useState(false);
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const { width } = useWindowDimensions();
  const narrow = width < 720;
  const router = useRouter();
  const selecting = selected.size > 0;

  // Segarkan state antrian dari penyimpanan (await dulu → setState setelah await).
  const refreshQueue = async () => {
    const q = await getQueue();
    setQueue(q);
  };

  // Putar antrian (replay anti-hilang) → muat ulang manifest agar baris terbaru muncul.
  const kickDrain = async () => {
    await drainQueue(token, () => { void refreshQueue(); });
    await load();
    void refreshQueue();
  };

  const toggleSelect = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  const ids = () => [...selected];

  const batchDelete = async () => {
    setBatchBusy(true); setNotice(null);
    try {
      const res = await Api.batch(token, 'delete', ids());
      const ok = res.results.filter((r) => r.ok).length;
      setNotice(`Menghapus ${ok} file`);
      clearSelection();
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal (${err.code})` : 'Server tidak terjangkau.');
    } finally { setBatchBusy(false); }
  };

  const batchMove = async (category: string) => {
    setBatchBusy(true); setNotice(null); setMovePicker(false);
    try {
      const res = await Api.batch(token, 'move', ids(), { category });
      const ok = res.results.filter((r) => r.ok).length;
      setNotice(`Memindahkan ${ok} file ke ${category.toUpperCase()}`);
      clearSelection();
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal (${err.code})` : 'Server tidak terjangkau.');
    } finally { setBatchBusy(false); }
  };

  const batchZip = () => {
    // Unduh massal sebagai ZIP (server streaming STORE). Buka di tab/browser baru.
    const url = Api.zipUrl(token, ids());
    if (Platform.OS === 'web') {
      (globalThis as unknown as { open: (u: string, t?: string) => void }).open(url, '_blank');
    } else {
      void import('react-native').then(({ Linking }) => Linking.openURL(url));
    }
    setNotice(`Mengunduh ZIP ${selected.size} file…`);
  };

  const load = useCallback(async () => {
    try {
      const [f, c, s] = await Promise.all([
        Api.files(token, active ?? undefined),
        Api.categories(token),
        Api.syncStatus(token),
      ]);
      setFiles(f.files);
      setCategories(c.categories);
      setSync(s);
      setNotice(null);
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal memuat (${err.code})` : 'Server tidak terjangkau.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token, active]);

  // load() selalu async (setState terjadi setelah await) — aman dari rule ini.
  useEffect(() => { void load(); }, [load]);

  // Replay antrian tertunda (crash recovery / app dibuka lagi) + putar saat online.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshQueue();
    void kickDrain();
    const onOnline = () => { void kickDrain(); };
    if (Platform.OS === 'web') globalThis.addEventListener('online', onOnline);
    return () => { if (Platform.OS === 'web') globalThis.removeEventListener('online', onOnline); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickAndUpload = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setUploading(true);
    setNotice(null);
    try {
      // Catat dulu ke antrian lokal (anti-hilang) → putar otomatis. Bila gagal
      // nanti, entri tetap "queued" dan diputar lagi saat app dibuka / online.
      await enqueueUpload({
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType ?? 'application/octet-stream',
        size: asset.size ?? 0,
      });
      setNotice(`Masuk antrian: ${asset.name}`);
      await kickDrain();
    } catch (err) {
      setNotice(err instanceof ApiError
        ? (err.code === 'FLOOD_WAIT' ? `Telegram minta jeda ${err.retryAfterSeconds ?? '?'} detik.` : `Gagal unggah (${err.code})`)
        : 'Server tidak terjangkau.');
    } finally {
      setUploading(false);
    }
  };

  const cancelQueued = async (id: string) => {
    await removeUpload(id);
    await refreshQueue();
  };
  const retryQueued = async (id: string) => {
    await retryUpload(id);
    await refreshQueue();
    void kickDrain();
  };

  const handleDownload = async (f: FileRow) => {
    setNotice(`Mengunduh ${f.name}…`);
    try {
      await downloadFile(token, f);
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal unduh (${err.code})` : 'Server tidak terjangkau.');
    }
  };

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <View>
          <Text style={styles.brand}>MANIFEST</Text>
          <Text style={styles.who}>{me.toUpperCase()} · {files.length} BARIS</Text>
        </View>
        <View style={styles.headerRight}>
          {sync && (
            <View style={styles.syncChip}>
              <View style={[styles.dot, { backgroundColor: sync.pending > 0 ? color.amber : color.green }]} />
              <Text style={styles.syncText}>
                {sync.pending > 0 ? `ANTRE ${sync.pending}` : `SINKRON ${sync.sent}`}
              </Text>
            </View>
          )}
          <Pressable onPress={() => void load()} style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}>
            {({ pressed }) => (
              <View style={styles.iconBtnInner}>
                <RefreshCw size={12} strokeWidth={1.5} color={pressed ? color.amber : color.textMuted} />
                <Text style={styles.iconBtnText}>MUAT</Text>
              </View>
            )}
          </Pressable>
          <Pressable onPress={() => router.push('/album')} style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}>
            <Text style={styles.iconBtnText}>ALBUM</Text>
          </Pressable>
          <Pressable onPress={() => router.push('/settings')} style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}>
            <Text style={styles.iconBtnText}>SETELAN</Text>
          </Pressable>
          <Pressable onPress={onLogout} style={({ pressed }) => [styles.iconBtn, pressed && { opacity: 0.6 }]}>
            <Text style={styles.iconBtnText}>KELUAR</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.body, narrow && styles.bodyColumn]}>
        <View style={[styles.railWrap, narrow ? styles.railWrapNarrow : null]}>
          <CategoryRail
            categories={categories}
            active={active}
            onSelect={setActive}
            layout={narrow ? 'horizontal' : 'vertical'}
          />
        </View>

        <View style={styles.listWrap}>
          {queue.length > 0 && (
            <View style={styles.queueBlock}>
              <View style={styles.queueHead}>
                <Text style={styles.queueTitle}>ANTRIAN LOKAL</Text>
                <Text style={styles.queueCount}>{queue.length}</Text>
              </View>
              {queue.map((q) => (
                <View key={q.clientUploadId} style={styles.queueRow}>
                  <View style={styles.queueMain}>
                    <Text style={styles.queueName} numberOfLines={1}>{q.name}</Text>
                    <Text style={[styles.queueState, { color: q.state === 'failed' || q.state === 'source_lost' ? color.red : q.state === 'uploading' ? color.amber : color.textMuted }]}>
                      {q.state === 'queued' ? 'ANTRE' : q.state === 'uploading' ? 'MENGUNGGAH…' : q.state === 'failed' ? `GAGAL${q.lastError ? ` · ${q.lastError}` : ''}` : 'SUMBER HILANG'}
                    </Text>
                  </View>
                  {(q.state === 'failed') && (
                    <Pressable onPress={() => void retryQueued(q.clientUploadId)} hitSlop={8} style={({ pressed }) => [styles.queueAct, pressed && { opacity: 0.6 }]}>
                      <Text style={styles.queueActText}>COBA</Text>
                    </Pressable>
                  )}
                  <Pressable onPress={() => void cancelQueued(q.clientUploadId)} hitSlop={8} style={({ pressed }) => [styles.queueAct, pressed && { opacity: 0.6 }]}>
                    <Text style={styles.queueActText}>BUANG</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          )}
          {loading ? (
            <View style={styles.center}><ActivityIndicator color={color.amber} /><Text style={styles.loadingText}>MEMUAT MANIFEST…</Text></View>
          ) : (
            <FlatList
              data={files}
              keyExtractor={(f) => String(f.id)}
              renderItem={({ item, index }) => (
                <ManifestRow
                  file={item}
                  index={index}
                  token={token}
                  selected={selected.has(item.id)}
                  onLongPress={(f) => toggleSelect(f.id)}
                  onPress={selecting ? (f) => toggleSelect(f.id) : setDrawer}
                  onDownload={(f) => void handleDownload(f)}
                />
              )}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={color.amber} />}
              ListEmptyComponent={
                <View style={styles.center}>
                  <Inbox size={40} strokeWidth={1} color={color.textFaint} />
                  <Text style={styles.emptyTitle}>GUDANG MASIH KOSONG</Text>
                  <Text style={styles.emptyBody}>Jatuhkan file pertama — sistem mengirimnya{'\n'}ke lorong kategori yang benar dan mencatatnya di sini.</Text>
                </View>
              }
            />
          )}
        </View>
      </View>

      <View style={styles.footer}>
        {notice && <Text style={styles.notice} numberOfLines={2}>{notice}</Text>}
        {selecting ? (
          <View style={styles.batchBar}>
            <Text style={styles.batchCount}>{selected.size} DIPILIH</Text>
            <View style={styles.batchActions}>
              <Pressable onPress={() => batchZip()} disabled={batchBusy} style={({ pressed }) => [styles.batchBtn, pressed && { opacity: 0.7 }]}>
                <Text style={styles.batchBtnText}>ZIP</Text>
              </Pressable>
              <Pressable onPress={() => setMovePicker(true)} disabled={batchBusy}
                style={({ pressed }) => [styles.batchBtn, pressed && { opacity: 0.7 }]}>
                <Text style={styles.batchBtnText}>PINDAH</Text>
              </Pressable>
              <Pressable onPress={() => void batchDelete()} disabled={batchBusy}
                style={({ pressed }) => [styles.batchBtnDanger, batchBusy && { opacity: 0.5 }, pressed && { opacity: 0.8 }]}>
                <Text style={styles.batchBtnDangerText}>HAPUS</Text>
              </Pressable>
              <Pressable onPress={clearSelection} style={({ pressed }) => [styles.batchBtn, pressed && { opacity: 0.7 }]}>
                <Text style={styles.batchBtnText}>BATAL</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={() => void pickAndUpload()}
            disabled={uploading}
            style={({ pressed }) => [styles.uploadBtn, uploading && { opacity: 0.6 }, pressed && { opacity: 0.85 }]}
          >
            {uploading
              ? <ActivityIndicator color={color.base} />
              : (
                <View style={styles.uploadInner}>
                  <Upload size={16} strokeWidth={1.5} color={color.base} />
                  <Text style={styles.uploadText}>UNGGAH FILE</Text>
                </View>
              )}
          </Pressable>
        )}
      </View>

      <FileDrawer
        file={drawer}
        token={token}
        categories={categories}
        onClose={() => setDrawer(null)}
        onDownload={handleDownload}
        onChanged={() => void load()}
      />

      {/* Picker pindah massal */}
      <Modal visible={movePicker} transparent animationType="fade" onRequestClose={() => setMovePicker(false)}>
        <View style={styles.pickerRoot}>
          <Pressable style={styles.pickerBackdrop} onPress={() => setMovePicker(false)} />
          <View style={styles.pickerBox}>
            <Text style={styles.pickerTitle}>PINDAH {selected.size} FILE KE</Text>
            {categories.map((c) => (
              <Pressable key={c.key} onPress={() => void batchMove(c.key)}
                style={({ pressed }) => [styles.pickerRow, pressed && { backgroundColor: color.surfaceAlt }]}>
                <Text style={styles.pickerRowText}>{c.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.base },
  header: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: space(4), paddingVertical: space(3),
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  brand: { color: color.textPrimary, fontSize: fontSize.lg, fontWeight: '700', letterSpacing: 2 },
  who: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1, marginTop: 2 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  syncChip: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.chip,
    paddingHorizontal: space(2.5), paddingVertical: space(1),
  },
  dot: { width: 5, height: 5, borderRadius: 3 },
  syncText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textMuted, letterSpacing: 0.5 },
  iconBtn: { borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control, paddingHorizontal: space(2.5), paddingVertical: space(1.5) },
  iconBtnInner: { flexDirection: 'row', alignItems: 'center', gap: space(1.5) },
  iconBtnText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textMuted, letterSpacing: 1 },
  body: { flex: 1, flexDirection: 'row' },
  bodyColumn: { flexDirection: 'column' },
  railWrap: { width: 172 },
  railWrapNarrow: { width: '100%', borderBottomWidth: 1, borderBottomColor: color.hairline, paddingHorizontal: space(3) },
  listWrap: { flex: 1 },
  queueBlock: { borderBottomWidth: 1, borderBottomColor: color.hairline, backgroundColor: color.surface },
  queueHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space(3), paddingVertical: space(2),
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  queueTitle: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 2 },
  queueCount: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textMuted, letterSpacing: 1 },
  queueRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space(3), paddingVertical: space(2.5),
    borderBottomWidth: 1, borderBottomColor: color.hairline, gap: space(3),
  },
  queueMain: { flex: 1, minWidth: 0 },
  queueName: { color: color.textPrimary, fontSize: fontSize.sm },
  queueState: { fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1, marginTop: 2 },
  queueAct: { paddingHorizontal: space(2), paddingVertical: space(1) },
  queueActText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.red, letterSpacing: 1 },
  center: { alignItems: 'center', padding: space(8), gap: space(3) },
  loadingText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 2 },
  emptyTitle: { fontFamily: font.mono, fontSize: fontSize.md, color: color.textMuted, letterSpacing: 2 },
  emptyBody: { color: color.textFaint, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  footer: { borderTopWidth: 1, borderTopColor: color.hairline, padding: space(3), gap: space(2) },
  notice: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 0.5 },
  uploadBtn: { backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(3.5), alignItems: 'center' },
  uploadInner: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  uploadText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
  batchBar: { gap: space(2) },
  batchCount: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 1.5 },
  batchActions: { flexDirection: 'row', gap: space(2), flexWrap: 'wrap' },
  batchBtn: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    paddingVertical: space(2.5), paddingHorizontal: space(3),
  },
  batchBtnText: { color: color.textMuted, fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1 },
  batchBtnDanger: { backgroundColor: color.red, borderRadius: radius.control, paddingVertical: space(2.5), paddingHorizontal: space(3) },
  batchBtnDangerText: { color: color.base, fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1, fontWeight: '700' },
  pickerRoot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pickerBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  pickerBox: { width: '82%', maxWidth: 380, backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline, padding: space(4) },
  pickerTitle: { fontFamily: font.mono, fontSize: fontSize.sm, color: color.amber, letterSpacing: 2, marginBottom: space(3) },
  pickerRow: {
    paddingVertical: space(3), paddingHorizontal: space(2),
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  pickerRowText: { color: color.textPrimary, fontSize: fontSize.base },
});
