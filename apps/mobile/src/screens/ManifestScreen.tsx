import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Modal, Platform, Pressable, RefreshControl,
  StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as DocumentPicker from 'expo-document-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Images, Inbox, Settings, Upload } from 'lucide-react-native';
import { Api, ApiError, downloadFile, type CategoryRow, type FileRow } from '../api';
import { ManifestRow } from '../components/ManifestRow';
import { CategoryRail } from '../components/CategoryRail';
import { FileDrawer } from '../components/FileDrawer';
import {
  drainQueue, enqueueUpload, getQueue, removeUpload, retryUpload, type QueueEntry,
} from '../uploadQueue';
import { color, fontSize, radius, scaleCap, space } from '../theme';
import {
  Btn, Card, EmptyState, Fab, IconBtn, Pill, Screen, ScreenHeader, SectionLabel,
} from '../components/ui';

/**
 * Manifest — layar utama: rail lorong kategori + daftar baris file
 * + unggah pintar + status sinkron.
 */
export function ManifestScreen({ token, me }: { token: string; me: string }) {
  const insets = useSafeAreaInsets();
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
  const wide = width >= 640;
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

  const dockBottom = Math.max(insets.bottom, 8) + 76;

  return (
    <Screen>
      <ScreenHeader
        title="Manifest"
        subtitle={`${me} · ${files.length} berkas`}
        right={(
          <>
            {sync && (
              <Pill
                text={sync.pending > 0 ? `${sync.pending} antre` : `Sinkron ${sync.sent}`}
                tint={sync.pending > 0 ? color.amber : color.green}
                bg={color.onPrimary}
              />
            )}
            <IconBtn
              label="Album"
              onPress={() => router.push('/album')}
              icon={<Images size={20} color={color.onPrimary} />}
            />
            <IconBtn
              label="Pengaturan"
              onPress={() => router.push('/settings')}
              icon={<Settings size={20} color={color.onPrimary} />}
            />
          </>
        )}
      />

      <View style={[styles.body, wide && styles.bodyWide]}>
        <View style={[styles.railWrap, wide && styles.railWrapWide]}>
          <CategoryRail
            categories={categories}
            active={active}
            onSelect={setActive}
            layout={wide ? 'vertical' : 'horizontal'}
          />
        </View>

        <View style={styles.listWrap}>
          {queue.length > 0 && (
            <Card style={styles.queueCard}>
              <View style={styles.queueHead}>
                <SectionLabel>Antrean lokal</SectionLabel>
                <Text style={styles.queueCount} maxFontSizeMultiplier={scaleCap.label}>{queue.length}</Text>
              </View>
              {queue.map((q) => (
                <View key={q.clientUploadId} style={styles.queueRow}>
                  <View style={styles.queueMain}>
                    <Text style={styles.queueName} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
                      {q.name}
                    </Text>
                    <Text
                      style={[styles.queueState, {
                        color: q.state === 'failed' || q.state === 'source_lost'
                          ? color.red
                          : q.state === 'uploading' ? color.amber : color.textMuted,
                      }]}
                      maxFontSizeMultiplier={scaleCap.label}
                    >
                      {q.state === 'queued' ? 'Antre' : q.state === 'uploading' ? 'Mengunggah…' : q.state === 'failed' ? `Gagal${q.lastError ? ` · ${q.lastError}` : ''}` : 'Sumber hilang'}
                    </Text>
                  </View>
                  {q.state === 'failed' && (
                    <Pressable
                      onPress={() => void retryQueued(q.clientUploadId)}
                      hitSlop={8}
                      style={({ pressed }) => [styles.queueAct, pressed && { opacity: 0.6 }]}
                    >
                      <Text style={styles.queueActText} maxFontSizeMultiplier={scaleCap.label}>Coba</Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => void cancelQueued(q.clientUploadId)}
                    hitSlop={8}
                    style={({ pressed }) => [styles.queueAct, pressed && { opacity: 0.6 }]}
                  >
                    <Text style={[styles.queueActText, { color: color.red }]} maxFontSizeMultiplier={scaleCap.label}>
                      Buang
                    </Text>
                  </Pressable>
                </View>
              ))}
            </Card>
          )}

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={color.primary} />
              <Text style={styles.loadingText} maxFontSizeMultiplier={scaleCap.label}>Memuat manifest…</Text>
            </View>
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
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={() => { setRefreshing(true); void load(); }}
                  tintColor={color.primary}
                />
              }
              contentContainerStyle={{
                padding: space(4),
                paddingBottom: dockBottom + 48,
                gap: space(2),
              }}
              ListEmptyComponent={
                <EmptyState
                  icon={<Inbox size={34} color={color.textFaint} />}
                  title="Gudang masih kosong"
                  body={'Jatuhkan file pertama — sistem mengirimnya ke lorong kategori yang benar dan mencatatnya di sini.'}
                />
              }
            />
          )}
        </View>
      </View>

      <View pointerEvents="box-none" style={[styles.dock, { bottom: dockBottom }]}>
        {notice && (
          <Text style={styles.notice} numberOfLines={2} maxFontSizeMultiplier={scaleCap.label}>
            {notice}
          </Text>
        )}
        {selecting && (
          <Card style={styles.batchBar}>
            <Text style={styles.batchCount} maxFontSizeMultiplier={scaleCap.label}>
              {selected.size} dipilih
            </Text>
            <View style={styles.batchActions}>
              <Btn label="ZIP" variant="ghost" onPress={() => batchZip()} disabled={batchBusy} />
              <Btn label="Pindah" variant="ghost" onPress={() => setMovePicker(true)} disabled={batchBusy} />
              <Btn label="Hapus" variant="danger" onPress={() => void batchDelete()} disabled={batchBusy} />
              <Btn label="Batal" variant="ghost" onPress={clearSelection} />
            </View>
          </Card>
        )}
      </View>

      {!selecting && (
        <Fab
          label="Unggah berkas"
          onPress={() => { if (!uploading) void pickAndUpload(); }}
          icon={uploading ? <ActivityIndicator color={color.onPrimary} /> : <Upload size={24} color={color.onPrimary} />}
          style={{ bottom: dockBottom }}
        />
      )}

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
            <Text style={styles.pickerTitle} maxFontSizeMultiplier={scaleCap.title}>
              Pindah {selected.size} file ke
            </Text>
            {categories.map((c) => (
              <Pressable
                key={c.key}
                onPress={() => void batchMove(c.key)}
                style={({ pressed }) => [styles.pickerRow, pressed && { backgroundColor: color.surfaceAlt }]}
              >
                <Text style={styles.pickerRowText} maxFontSizeMultiplier={scaleCap.label}>{c.label}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  bodyWide: { flexDirection: 'row' },
  railWrap: {},
  railWrapWide: { width: 208 },
  listWrap: { flex: 1 },
  center: { alignItems: 'center', padding: space(8), gap: space(3) },
  loadingText: { color: color.textFaint, fontSize: fontSize.sm },
  queueCard: { margin: space(4), marginBottom: 0, padding: space(4), gap: space(2) },
  queueHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  queueCount: { color: color.textMuted, fontSize: fontSize.sm, fontWeight: '600' },
  queueRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: space(3), paddingVertical: space(2),
  },
  queueMain: { flex: 1, minWidth: 0 },
  queueName: { color: color.textPrimary, fontSize: fontSize.sm },
  queueState: { fontSize: fontSize.xs, marginTop: 2 },
  queueAct: {
    minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.control,
  },
  queueActText: { color: color.primary, fontSize: fontSize.sm, fontWeight: '600' },
  dock: { position: 'absolute', left: space(4), right: space(4), gap: space(2) },
  notice: { color: color.textMuted, fontSize: fontSize.xs, textAlign: 'center', paddingRight: 72 },
  batchBar: { padding: space(3), gap: space(2) },
  batchCount: { color: color.textPrimary, fontSize: fontSize.sm, fontWeight: '600' },
  batchActions: { flexDirection: 'row', gap: space(2), flexWrap: 'wrap' },
  pickerRoot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pickerBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim },
  pickerBox: {
    width: '82%', maxWidth: 380, backgroundColor: color.surface,
    borderRadius: radius.sheet, padding: space(5),
  },
  pickerTitle: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: '700', marginBottom: space(3) },
  pickerRow: {
    minHeight: 48, justifyContent: 'center', paddingHorizontal: space(2),
    borderRadius: radius.control,
  },
  pickerRowText: { color: color.textPrimary, fontSize: fontSize.base },
});
