import { useEffect, useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Search } from 'lucide-react-native';
import { Api, ApiError, downloadFile, type CategoryRow, type FileRow, type ParsedQuery } from '../api';
import { ManifestRow } from '../components/ManifestRow';
import { FileDrawer } from '../components/FileDrawer';
import { color, fontSize, radius, scaleCap, space } from '../theme';
import { EmptyState, IconBtn, Screen, ScreenHeader } from '../components/ui';

const SUGGESTIONS = ['pdf laporan juni', 'gambar bulan lalu', 'video >100mb', 'xlsx 2025', 'kemarin'];

function describeParsed(p: ParsedQuery): string[] {
  const chips: string[] = [];
  if (p.ext) chips.push(`Ekstensi .${p.ext}`);
  if (p.category) chips.push(`Kategori ${p.category.toUpperCase()}`);
  if (p.dateFrom && p.dateTo) {
    const f = (iso: string) => iso.slice(0, 10);
    chips.push(p.dateFrom.slice(0, 7) === p.dateTo.slice(0, 7)
      ? `Bulan ${f(p.dateFrom).slice(0, 7)}`
      : `${f(p.dateFrom)} → ${f(p.dateTo)}`);
  } else if (p.dateFrom) chips.push(`Sejak ${p.dateFrom.slice(0, 10)}`);
  else if (p.dateTo) chips.push(`Sampai ${p.dateTo.slice(0, 10)}`);
  if (p.minSize != null) chips.push(`≥ ${Math.round(p.minSize / 1024 / 1024)} MB`);
  if (p.text) chips.push(`Teks "${p.text}"`);
  return chips;
}

/** Cari — chat search: query bahasa sehari-hari → parser → hasil manifest. */
export function SearchScreen({ token }: { token: string }) {
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const [results, setResults] = useState<FileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<FileRow | null>(null);
  const [categories, setCategories] = useState<CategoryRow[]>([]);

  // Muat daftar kategori (untuk pindah kategori di drawer).
  useEffect(() => {
    void Api.categories(token).then((c) => setCategories(c.categories)).catch(() => undefined);
  }, [token]);

  const run = async (query: string) => {
    if (!query.trim()) return;
    setBusy(true); setError(null);
    try {
      const res = await Api.search(token, query);
      setParsed(res.parsed);
      setResults(res.results);
    } catch (err) {
      setError(err instanceof ApiError ? `Pencarian gagal (${err.code})` : 'Server tidak terjangkau.');
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async (f: FileRow) => {
    try {
      await downloadFile(token, f);
    } catch (err) {
      setError(err instanceof ApiError ? `Gagal unduh (${err.code})` : 'Server tidak terjangkau.');
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Cari berkas" subtitle="Tanya apa saja — “pdf laporan juni”, “video >100mb”" />

      <View style={styles.inputRow}>
        <Search size={18} color={color.textFaint} />
        <TextInput
          style={styles.input}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => void run(q)}
          placeholder="cari file…"
          placeholderTextColor={color.textFaint}
          returnKeyType="search"
          autoCapitalize="none"
          maxFontSizeMultiplier={scaleCap.label}
        />
        <IconBtn
          label="Cari"
          onPress={() => void run(q)}
          icon={busy
            ? <ActivityIndicator color={color.primary} size="small" />
            : <Search size={18} color={color.primary} />}
        />
      </View>

      {parsed && (
        <ScrollView
          horizontal
          contentContainerStyle={styles.chips}
          showsHorizontalScrollIndicator={false}
        >
          {describeParsed(parsed).map((c) => (
            <View key={c} style={styles.chip}>
              <Text style={styles.chipText} maxFontSizeMultiplier={scaleCap.label}>{c}</Text>
            </View>
          ))}
        </ScrollView>
      )}

      {error && <Text style={styles.error} maxFontSizeMultiplier={scaleCap.label}>{error}</Text>}

      <View style={styles.results}>
        {results === null ? (
          <EmptyState
            icon={<Search size={34} color={color.textFaint} />}
            title="Pencarian siap"
            body={'Parser memahami kategori, nama, ekstensi, bulan, tanggal, dan ukuran.'}
          >
            <View style={styles.suggestWrap}>
              {SUGGESTIONS.map((s) => (
                <Pressable
                  key={s}
                  onPress={() => { setQ(s); void run(s); }}
                  style={({ pressed }) => [styles.suggest, pressed && { opacity: 0.6 }]}
                >
                  <Text style={styles.suggestText} maxFontSizeMultiplier={scaleCap.label}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </EmptyState>
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Search size={34} color={color.textFaint} />}
            title="Tidak ada di gudang"
            body="Coba longgarkan filter — mis. hapus bulannya."
          />
        ) : (
          <FlatList
            data={results}
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
            contentContainerStyle={{ paddingBottom: insets.bottom + 110, gap: space(2), padding: space(4) }}
            ListHeaderComponent={
              <Text style={styles.count} maxFontSizeMultiplier={scaleCap.label}>
                {results.length} hasil
              </Text>
            }
          />
        )}
      </View>

      <FileDrawer
        file={drawer}
        token={token}
        categories={categories}
        onClose={() => setDrawer(null)}
        onDownload={handleDownload}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: space(2),
    marginHorizontal: space(4), marginTop: space(4),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.container,
    backgroundColor: color.surface, paddingLeft: space(3.5), paddingRight: space(1.5),
    minHeight: 48,
  },
  input: {
    flex: 1, color: color.textPrimary, fontSize: fontSize.base,
    paddingVertical: space(3),
  },
  chips: {
    gap: space(2), padding: space(4), paddingBottom: space(2),
    // ScrollView horizontal di web punya alignItems 'stretch' default → chip
    // ikut memanjang setinggi container jadi pil raksasa. Kunci ke atas.
    alignItems: 'flex-start',
  },
  chip: {
    borderRadius: radius.chip, paddingHorizontal: space(3), paddingVertical: space(1.5),
    backgroundColor: color.primarySoft,
  },
  chipText: { color: color.primary, fontSize: fontSize.xs, fontWeight: '600' },
  error: { color: color.red, fontSize: fontSize.sm, paddingHorizontal: space(4) },
  results: { flex: 1, marginTop: space(2) },
  suggestWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), justifyContent: 'center', marginTop: space(3) },
  suggest: {
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.chip,
    paddingHorizontal: space(3), paddingVertical: space(2), backgroundColor: color.surface,
  },
  suggestText: { color: color.textMuted, fontSize: fontSize.xs },
  count: { color: color.textFaint, fontSize: fontSize.xs, paddingHorizontal: space(4), paddingVertical: space(2) },
});
