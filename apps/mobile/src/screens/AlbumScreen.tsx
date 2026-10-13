import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Modal, Pressable, RefreshControl,
  StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FolderPlus, Images, Plus, Trash2 } from 'lucide-react-native';
import { Api, ApiError, usePreviewUri, type AlbumRow, type FileRow } from '../api';
import { glyphFor, tinted } from '../fileType';
import { color, fontSize, radius, scaleCap, space } from '../theme';
import { EmptyState, IconBtn, Screen, ScreenHeader } from '../components/ui';

/** Satu sel contact-sheet: thumbnail gambar atau glyph berwarna, plus nama. */
function SheetCell({ file, token, onPress }: { file: FileRow; token: string | null; onPress: () => void }) {
  const glyph = glyphFor(file.ext);
  const canThumb = glyph.image && file.channelId != null;
  const [fail, setFail] = useState(false);
  const previewUri = usePreviewUri(file, token, canThumb);

  return (
    <Pressable style={styles.cell} onPress={onPress} accessibilityRole="imagebutton"
      accessibilityLabel={file.displayName || file.name}>
      <View style={[styles.thumb, { backgroundColor: tinted(glyph.color, 0.1), borderColor: color.hairline }]}>
        {canThumb && !fail ? (
          <Image
            source={{ uri: previewUri }}
            style={styles.thumbImg}
            resizeMode="cover"
            onError={() => setFail(true)}
          />
        ) : (
          <glyph.Icon size={26} strokeWidth={1.2} color={glyph.color} />
        )}
      </View>
      <Text style={styles.cellName} numberOfLines={1} maxFontSizeMultiplier={scaleCap.label}>
        {file.displayName || file.name}
      </Text>
    </Pressable>
  );
}

/**
 * Album — koleksi manual lintas kategori (kontak-sheet). Daftar album
 * (atau grid di layar sempit), isi album sebagai grid contact-sheet.
 */
export function AlbumScreen({ token, onBack }: { token: string; onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const cols = width >= 640 ? 4 : 3;
  const [albums, setAlbums] = useState<AlbumRow[]>([]);
  const [active, setActive] = useState<AlbumRow | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    try {
      const { albums: a } = await Api.albums(token);
      setAlbums(a);
      setNotice(null);
      // pertahankan album aktif bila masih ada
      setActive((cur) => (cur ? (a.find((x) => x.id === cur.id) ?? null) : null));
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal memuat (${err.code})` : 'Server tidak terjangkau.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [token]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { void load(); }, [load]);

  // Muat isi album saat album aktif berubah.
  useEffect(() => {
    if (!active) { setFiles([]); return; }
    let cancelled = false;
    void Api.albumFiles(token, active.id)
      .then((r) => { if (!cancelled) setFiles(r.files); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [token, active]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const createAlbum = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true); setNotice(null);
    try {
      const { album } = await Api.createAlbum(token, name);
      setNewName('');
      setCreating(false);
      setAlbums((prev) => [album, ...prev]);
      setActive(album);
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal (${err.code})` : 'Server tidak terjangkau.');
    } finally { setBusy(false); }
  };

  const removeAlbum = async (id: number) => {
    setBusy(true); setNotice(null);
    try {
      await Api.deleteAlbum(token, id);
      if (active?.id === id) setActive(null);
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? `Gagal (${err.code})` : 'Server tidak terjangkau.');
    } finally { setBusy(false); }
  };

  return (
    <Screen>
      <ScreenHeader
        title={active ? active.name : 'Album'}
        subtitle={active ? `${files.length} file` : `${albums.length} koleksi`}
        onBack={active ? () => setActive(null) : onBack}
        right={!active ? (
          <IconBtn
            label="Album baru"
            onPress={() => setCreating(true)}
            icon={<FolderPlus size={20} color={color.onPrimary} />}
          />
        ) : undefined}
      />

      {notice && <Text style={styles.notice} maxFontSizeMultiplier={scaleCap.label}>{notice}</Text>}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={color.primary} />
          <Text style={styles.loadingText} maxFontSizeMultiplier={scaleCap.label}>Memuat album…</Text>
        </View>
      ) : !active ? (
        <FlatList
          data={albums}
          keyExtractor={(a) => String(a.id)}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); void load(); }}
              tintColor={color.primary}
            />
          }
          contentContainerStyle={{
            padding: space(4), paddingBottom: insets.bottom + 110, gap: space(2),
          }}
          renderItem={({ item }) => (
            <Pressable
              style={styles.albumRow}
              onPress={() => setActive(item)}
              accessibilityRole="button"
              accessibilityLabel={`Buka album ${item.name}`}
            >
              <View style={styles.albumIcon}>
                <Images size={18} strokeWidth={1.5} color={color.primary} />
              </View>
              <View style={styles.albumMain}>
                <Text style={styles.albumName} maxFontSizeMultiplier={scaleCap.label}>{item.name}</Text>
                <Text style={styles.albumCount} maxFontSizeMultiplier={scaleCap.label}>
                  {item.fileCount} file · {new Date(item.createdAt).toISOString().slice(0, 10)}
                </Text>
              </View>
              <Pressable
                onPress={() => void removeAlbum(item.id)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Hapus album ${item.name}`}
                style={({ pressed }) => [styles.rowAction, pressed && { opacity: 0.6 }]}
              >
                <Trash2 size={16} strokeWidth={1.5} color={color.red} />
              </Pressable>
            </Pressable>
          )}
          ListEmptyComponent={
            <EmptyState
              icon={<Images size={34} color={color.textFaint} />}
              title="Belum ada album"
              body={'Koleksi manual lintas kategori — kumpulkan file pilihanmu di sini.'}
            />
          }
        />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(f) => String(f.id)}
          numColumns={cols}
          contentContainerStyle={{
            padding: space(3), paddingBottom: insets.bottom + 110, gap: space(2),
          }}
          columnWrapperStyle={cols > 1 ? { gap: space(2) } : undefined}
          renderItem={({ item }) => <SheetCell file={item} token={token} onPress={() => undefined} />}
          ListEmptyComponent={
            <EmptyState
              icon={<Images size={34} color={color.textFaint} />}
              title="Album kosong"
              body="Tambahkan file dari manifest lewat menu album."
            />
          }
        />
      )}

      {/* Dialog buat album */}
      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.dialogRoot}>
          <Pressable style={styles.dialogBackdrop} onPress={() => setCreating(false)} />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle} maxFontSizeMultiplier={scaleCap.title}>Album baru</Text>
            <TextInput
              style={styles.dialogInput}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              placeholder="nama koleksi"
              placeholderTextColor={color.textFaint}
              onSubmitEditing={() => void createAlbum()}
              maxFontSizeMultiplier={scaleCap.label}
            />
            <View style={styles.dialogActions}>
              <Pressable
                onPress={() => setCreating(false)}
                style={({ pressed }) => [styles.dialogBtn, pressed && { opacity: 0.6 }]}
              >
                <Text style={styles.dialogBtnText} maxFontSizeMultiplier={scaleCap.label}>Batal</Text>
              </Pressable>
              <Pressable
                onPress={() => void createAlbum()}
                disabled={busy || !newName.trim()}
                style={({ pressed }) => [styles.dialogBtnPrimary, (busy || !newName.trim()) && { opacity: 0.5 }, pressed && { opacity: 0.85 }]}
              >
                <Plus size={16} strokeWidth={2} color={color.onPrimary} />
                <Text style={styles.dialogBtnPrimaryText} maxFontSizeMultiplier={scaleCap.label}>Buat</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', padding: space(8), gap: space(3) },
  loadingText: { color: color.textFaint, fontSize: fontSize.sm },
  notice: { color: color.red, fontSize: fontSize.xs, paddingHorizontal: space(4), paddingTop: space(3) },
  albumRow: {
    flexDirection: 'row', alignItems: 'center', gap: space(3),
    backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline,
    borderRadius: radius.card, paddingHorizontal: space(3), paddingVertical: space(3),
  },
  albumIcon: {
    width: 40, height: 40, borderRadius: radius.control, backgroundColor: color.primarySoft,
    alignItems: 'center', justifyContent: 'center',
  },
  albumMain: { flex: 1 },
  albumName: { color: color.textPrimary, fontSize: fontSize.base, fontWeight: '600' },
  albumCount: { color: color.textFaint, fontSize: fontSize.xs, marginTop: 2 },
  rowAction: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.control,
  },
  cell: { flex: 1 },
  thumb: {
    width: '100%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderRadius: radius.control, overflow: 'hidden',
  },
  thumbImg: { width: '100%', height: '100%' },
  cellName: { color: color.textMuted, fontSize: fontSize.xs, marginTop: space(1.5) },
  dialogRoot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dialogBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.scrim },
  dialog: {
    width: '86%', maxWidth: 400, backgroundColor: color.surface,
    borderRadius: radius.sheet, padding: space(5),
  },
  dialogTitle: { color: color.textPrimary, fontSize: fontSize.md, fontWeight: '700', marginBottom: space(4) },
  dialogInput: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    backgroundColor: color.surface, color: color.textPrimary,
    paddingHorizontal: space(3.5), paddingVertical: space(3), fontSize: fontSize.base,
  },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space(2), marginTop: space(4) },
  dialogBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space(3) },
  dialogBtnText: { color: color.textMuted, fontSize: fontSize.sm },
  dialogBtnPrimary: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    backgroundColor: color.primary, borderRadius: radius.control,
    minHeight: 44, paddingHorizontal: space(4), paddingVertical: space(2.5),
  },
  dialogBtnPrimaryText: { color: color.onPrimary, fontWeight: '700', fontSize: fontSize.sm },
});
