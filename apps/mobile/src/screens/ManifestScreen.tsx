import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, useWindowDimensions, View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Inbox, RefreshCw, Upload } from 'lucide-react-native';
import { Api, ApiError, downloadFile, type CategoryRow, type FileRow } from '../api';
import { ManifestRow } from '../components/ManifestRow';
import { CategoryRail } from '../components/CategoryRail';
import { FileDrawer } from '../components/FileDrawer';
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
  const { width } = useWindowDimensions();
  const narrow = width < 720;

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

  // load() selalu async (setState terjadi setelah await) — false positive rule ini.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const pickAndUpload = async () => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    if (res.canceled || !res.assets?.[0]) return;
    const asset = res.assets[0];
    setUploading(true);
    setNotice(null);
    try {
      const up = await Api.upload(token, { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/octet-stream' });
      setNotice(`Terkirim ke ${up.file.categoryKey.toUpperCase()} · baris #${String(up.file.id).padStart(4, '0')} tercatat`);
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError
        ? (err.code === 'FLOOD_WAIT' ? `Telegram minta jeda ${err.retryAfterSeconds ?? '?'} detik.` : `Gagal unggah (${err.code})`)
        : 'Server tidak terjangkau.');
    } finally {
      setUploading(false);
    }
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
                  onPress={setDrawer}
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
      </View>

      <FileDrawer file={drawer} token={token} onClose={() => setDrawer(null)} onDownload={handleDownload} />
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
  center: { alignItems: 'center', padding: space(8), gap: space(3) },
  loadingText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 2 },
  emptyTitle: { fontFamily: font.mono, fontSize: fontSize.md, color: color.textMuted, letterSpacing: 2 },
  emptyBody: { color: color.textFaint, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  footer: { borderTopWidth: 1, borderTopColor: color.hairline, padding: space(3), gap: space(2) },
  notice: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 0.5 },
  uploadBtn: { backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(3.5), alignItems: 'center' },
  uploadInner: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  uploadText: { color: color.base, fontWeight: '700', letterSpacing: 1.5, fontSize: fontSize.sm },
});
