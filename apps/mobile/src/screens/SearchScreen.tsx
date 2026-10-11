import { useState } from 'react';
import {
  ActivityIndicator, FlatList, Pressable, ScrollView,
  StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Search } from 'lucide-react-native';
import { Api, ApiError, downloadFile, type FileRow, type ParsedQuery } from '../api';
import { ManifestRow } from '../components/ManifestRow';
import { FileDrawer } from '../components/FileDrawer';
import { color, font, fontSize, radius, space } from '../theme';

const SUGGESTIONS = ['pdf laporan juni', 'gambar bulan lalu', 'video >100mb', 'xlsx 2025', 'kemarin'];

function describeParsed(p: ParsedQuery): string[] {
  const chips: string[] = [];
  if (p.ext) chips.push(`EKSTENSI .${p.ext}`);
  if (p.category) chips.push(`KATEGORI ${p.category.toUpperCase()}`);
  if (p.dateFrom && p.dateTo) {
    const f = (iso: string) => iso.slice(0, 10);
    chips.push(p.dateFrom.slice(0, 7) === p.dateTo.slice(0, 7)
      ? `BULAN ${f(p.dateFrom).slice(0, 7)}`
      : `${f(p.dateFrom)} → ${f(p.dateTo)}`);
  } else if (p.dateFrom) chips.push(`SEJAK ${p.dateFrom.slice(0, 10)}`);
  else if (p.dateTo) chips.push(`SAMPAI ${p.dateTo.slice(0, 10)}`);
  if (p.minSize != null) chips.push(`≥ ${Math.round(p.minSize / 1024 / 1024)} MB`);
  if (p.text) chips.push(`TEKS "${p.text}"`);
  return chips;
}

/** Cari — chat search: query bahasa sehari-hari → parser → hasil manifest. */
export function SearchScreen({ token }: { token: string }) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const [results, setResults] = useState<FileRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<FileRow | null>(null);

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
    <View style={styles.root}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Search size={18} strokeWidth={1.5} color={color.amber} />
          <Text style={styles.title}>CARI</Text>
        </View>
        <Text style={styles.sub}>TANYAKAN APA SAJA — “PDF LAPORAN JUNI”, “GAMBAR BULAN LALU”</Text>
      </View>

      <View style={styles.inputRow}>
        <Text style={styles.prompt}>›</Text>
        <TextInput
          style={styles.input}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={() => void run(q)}
          placeholder="cari file…"
          placeholderTextColor={color.textFaint}
          returnKeyType="search"
          autoCapitalize="none"
        />
        <Pressable onPress={() => void run(q)} disabled={busy || !q.trim()}
          style={({ pressed }) => [styles.goBtn, (busy || !q.trim()) && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
          {busy ? <ActivityIndicator color={color.amber} size="small" /> : <Text style={styles.goText}>CARI</Text>}
        </Pressable>
      </View>

      {parsed && (
        <ScrollView horizontal contentContainerStyle={styles.chips} showsHorizontalScrollIndicator={false}>
          {describeParsed(parsed).map((c) => (
            <View key={c} style={styles.chip}><Text style={styles.chipText}>{c}</Text></View>
          ))}
        </ScrollView>
      )}

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.results}>
        {results === null ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>SATPAM SIAP</Text>
            <Text style={styles.emptyBody}>Parser memahami kategori, nama, ekstensi,{'\n'}bulan, tanggal, dan ukuran.</Text>
            <View style={styles.suggestWrap}>
              {SUGGESTIONS.map((s) => (
                <Pressable key={s} onPress={() => { setQ(s); void run(s); }}
                  style={({ pressed }) => [styles.suggest, pressed && { opacity: 0.6 }]}>
                  <Text style={styles.suggestText}>{s}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : results.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.emptyTitle}>TIDAK ADA DI GUDANG</Text>
            <Text style={styles.emptyBody}>Coba longgarkan filter — mis. hapus bulannya.</Text>
          </View>
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
            ListHeaderComponent={<Text style={styles.count}>{results.length} HASIL</Text>}
          />
        )}
      </View>

      <FileDrawer file={drawer} token={token} onClose={() => setDrawer(null)} onDownload={handleDownload} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.base },
  header: { paddingHorizontal: space(4), paddingVertical: space(3), borderBottomWidth: 1, borderBottomColor: color.hairline },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: space(2) },
  title: { color: color.textPrimary, fontSize: fontSize.lg, fontWeight: '700', letterSpacing: 2 },
  sub: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1, marginTop: 2 },
  inputRow: {
    flexDirection: 'row', alignItems: 'center', gap: space(2),
    marginHorizontal: space(4), marginTop: space(4),
    borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control,
    backgroundColor: color.surface, paddingHorizontal: space(3),
  },
  prompt: { fontFamily: font.mono, fontSize: fontSize.lg, color: color.amber },
  input: { flex: 1, color: color.textPrimary, fontFamily: font.mono, fontSize: fontSize.base, paddingVertical: space(3) },
  goBtn: { paddingHorizontal: space(3), paddingVertical: space(2), borderRadius: radius.control, backgroundColor: color.amberDim },
  goText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber, letterSpacing: 1 },
  chips: {
    gap: space(2), padding: space(4), paddingBottom: space(2),
    // ScrollView horizontal di web punya alignItems 'stretch' default → chip
    // ikut memanjang setinggi container jadi pil raksasa. Kunci ke atas.
    alignItems: 'flex-start',
  },
  chip: {
    borderWidth: 1, borderColor: color.amberDim, borderRadius: radius.chip,
    paddingHorizontal: space(2.5), paddingVertical: space(1),
    backgroundColor: color.surface, // alas solid turunkan kontras tepi → fringe minim
  },
  chipText: {
    fontFamily: font.mono, fontSize: fontSize.xs, color: color.amber,
    letterSpacing: 0.3, fontWeight: '500', // glyph lebih berat & rapat = tepi lebih bersih
  },
  error: { color: color.red, fontSize: fontSize.sm, paddingHorizontal: space(4) },
  results: { flex: 1, marginTop: space(2) },
  center: { alignItems: 'center', padding: space(8), gap: space(3) },
  emptyTitle: { fontFamily: font.mono, fontSize: fontSize.md, color: color.textMuted, letterSpacing: 2 },
  emptyBody: { color: color.textFaint, fontSize: fontSize.sm, textAlign: 'center', lineHeight: 20 },
  suggestWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2), justifyContent: 'center', marginTop: space(3) },
  suggest: { borderWidth: 1, borderColor: color.hairline, borderRadius: radius.control, paddingHorizontal: space(3), paddingVertical: space(2) },
  suggestText: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textMuted },
  count: { fontFamily: font.mono, fontSize: fontSize.xs, color: color.textFaint, letterSpacing: 1, paddingHorizontal: space(4), paddingVertical: space(2) },
});
