import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Image, Modal, Pressable, RefreshControl,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { ArrowLeft, FolderPlus, Images, Plus, Trash2 } from 'lucide-react-native';
import { Api, ApiError, fileDownloadUrl, type AlbumRow, type FileRow } from '../api';
import { glyphFor, tinted } from '../fileType';
import { color, font, fontSize, radius, space } from '../theme';

/** Satu sel contact-sheet: thumbnail gambar atau glyph berwarna, plus nama. */
function SheetCell({ file, token, onPress }: { file: FileRow; token: string | null; onPress: () => void }) {
  const glyph = glyphFor(file.ext);
  const canThumb = glyph.image && file.channelId != null;
  const [fail, setFail] = useState(false);

  return (
    <Pressable style={styles.cell} onPress={onPress}>
      <View style={[styles.thumb, { backgroundColor: tinted(glyph.color, 0.1), borderColor: color.hairline }]}>
        {canThumb && !fail ? (
          <Image
            source={{ uri: fileDownloadUrl(file, token) }}
            style={styles.thumbImg}
            resizeMode="cover"
            onError={() => setFail(true)}
          />
        ) : (
          <glyph.Icon size={28} strokeWidth={1.2} color={glyph.color} />
        )}
      </View>
      <Text style={styles.cellName} numberOfLines={1}>{file.displayName || file.name}</Text>
    </Pressable>
  );
}

/**
 * Album — koleksi manual lintas kategori (kontak-sheet). Daftar album di kiri
 * (atau atas di layar sempit), isi album sebagai grid contact-sheet.
 * Tambah/hapus album, buka file → drawer tidak di sini (cukup lihat).
 */
export function AlbumScreen({ token, onBack }: { token: string; onBack: () => void }) {
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
    <View style={styles.root}>
      <View style={styles.header}>
        <Pressable onPress={active ? () => setActive(null) : onBack} hitSlop={8} style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
          <ArrowLeft size={18} strokeWidth={1.5} color={color.textMuted} />
        </Pressable>
        <View style={styles.headMain}>
          <Text style={styles.brand}>{active ? active.name.toUpperCase() : 'ALBUM'}</Text>
          <Text style={styles.sub}>{active ? `${files.length} FILE` : `${albums.length} KOLEKSI`}</Text>
        </View>
        {!active && (
          <Pressable onPress={() => setCreating(true)} hitSlop={8} style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
            <FolderPlus size={17} strokeWidth={1.5} color={color.amber} />
          </Pressable>
        )}
      </View>

      {notice && <Text style={styles.notice}>{notice}</Text>}

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={color.amber} /><Text style={styles.loadingText}>MEMUAT ALBUM…</Text></View>
      ) : !active ? (
        <FlatList
          data={albums}
          keyExtractor={(a) => String(a.id)}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={color.amber} />}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => (
            <Pressable style={styles.albumRow} onPress={() => setActive(item)}>
              <Images size={18} strokeWidth={1.5} color={color.amber} />
              <View style={styles.albumMain}>
                <Text style={styles.albumName}>{item.name}</Text>
                <Text style={styles.albumCount}>{item.fileCount} FILE · {new Date(item.createdAt).toISOString().slice(0, 10)}</Text>
              </View>
              <Pressable onPress={() => void removeAlbum(item.id)} hitSlop={8} style={({ pressed }) => [styles.rowAction, pressed && { opacity: 0.6 }]}>
                <Trash2 size={15} strokeWidth={1.5} color={color.red} />
              </Pressable>
            </Pressable>
          )}
          ListEmptyComponent={
            <View style={styles.center}>
              <Images size={40} strokeWidth={1} color={color.textFaint} />
              <Text style={styles.emptyTitle}>BELUM ADA ALBUM</Text>
              <Text style={styles.emptyBody}>Koleksi manual lintas kategori —{'\n'}kumpulkan file pilihanmu di sini.</Text>
            </View>
          }
        />
      ) : (
        <FlatList
          data={files}
          keyExtractor={(f) => String(f.id)}
          numColumns={3}
          contentContainerStyle={styles.gridContent}
          renderItem={({ item }) => <SheetCell file={item} token={token} onPress={() => undefined} />}
          ListEmptyComponent={
            <View style={styles.center}>
              <Text style={styles.emptyTitle}>ALBUM KOSONG</Text>
              <Text style={styles.emptyBody}>Tambahkan file dari manifest lewat menu album.</Text>
            </View>
          }
        />
      )}

      {/* Dialog buat album */}
      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.dialogRoot}>
          <Pressable style={styles.dialogBackdrop} onPress={() => setCreating(false)} />
          <View style={styles.dialog}>
            <Text style={styles.dialogTitle}>ALBUM BARU</Text>
            <TextInput
              style={styles.dialogInput}
              value={newName}
              onChangeText={setNewName}
              autoFocus
              placeholder="nama koleksi"
              placeholderTextColor={color.textFaint}
              onSubmitEditing={() => void createAlbum()}
            />
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setCreating(false)} style={({ pressed }) => [styles.dialogBtn, pressed && { opacity: 0.6 }]}>
                <Text style={styles.dialogBtnText}>BATAL</Text>
              </Pressable>
              <Pressable onPress={() => void createAlbum()} disabled={busy || !newName.trim()}
                style={({ pressed }) => [styles.dialogBtnPrimary, (busy || !newName.trim()) && { opacity: 0.5 }, pressed && { opacity: 0.85 }]}>
                <Plus size={15} strokeWidth={2} color={color.base} />
                <Text style={styles.dialogBtnPrimaryText}>BUAT</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.base },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: space(3),
    paddingHorizontal: space(4), paddingVertical: space(3),
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  back: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control },
  headMain: { flex: 1 },
  brand: { color: color.textPrimary, fontSize: fontSize.lg, fontWeight: '700', letterSpacing: 2 },
  sub: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1, marginTop: 2 },
  notice: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.red, letterSpacing: 0.5, paddingHorizontal: space(4), paddingTop: space(3) },
  center: { alignItems: 'center', padding: space(8), gap: space(3) },
  loadingText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 2 },
  emptyTitle: { fontFamily: font.mono, fontSize: fontSize.md, color: color.textMuted, letterSpacing: 2 },
  emptyBody: { color: color.textFaint, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  listContent: { padding: space(3) },
  albumRow: {
    flexDirection: 'row', alignItems: 'center', gap: space(3),
    paddingHorizontal: space(3), paddingVertical: space(3.5),
    borderBottomWidth: 1, borderBottomColor: color.hairline,
  },
  albumMain: { flex: 1 },
  albumName: { color: color.textPrimary, fontSize: fontSize.base, fontWeight: '600' },
  albumCount: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 0.5, marginTop: 2 },
  rowAction: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  gridContent: { padding: space(2) },
  cell: { flex: 1 / 3, margin: space(1.5), maxWidth: '33.33%' },
  thumb: { width: '100%', aspectRatio: 1, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderRadius: radius.control, overflow: 'hidden' },
  thumbImg: { width: '100%', height: '100%' },
  cellName: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textMuted, marginTop: space(1.5) },
  dialogRoot: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  dialogBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)' },
  dialog: { width: '86%', maxWidth: 400, backgroundColor: color.surface, borderWidth: 1, borderColor: color.hairline, padding: space(5) },
  dialogTitle: { fontFamily: font.mono, fontSize: fontSize.sm, color: color.amber, letterSpacing: 2, marginBottom: space(4) },
  dialogInput: {
    borderWidth: 1, borderColor: color.hairline, backgroundColor: color.base, color: color.textPrimary,
    paddingHorizontal: space(3), paddingVertical: space(3), fontSize: fontSize.base,
  },
  dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space(2), marginTop: space(4) },
  dialogBtn: { paddingVertical: space(3), paddingHorizontal: space(3) },
  dialogBtnText: { color: color.textMuted, fontFamily: font.mono, fontSize: fontSize.xs, letterSpacing: 1 },
  dialogBtnPrimary: {
    flexDirection: 'row', alignItems: 'center', gap: space(1.5),
    backgroundColor: color.amber, borderRadius: radius.control, paddingVertical: space(2.5), paddingHorizontal: space(4),
  },
  dialogBtnPrimaryText: { color: color.base, fontWeight: '700', letterSpacing: 1, fontSize: fontSize.sm },
});
