# Brainstorm — Unduh File + Ikon Tipe + Drawer Detail (iterasi UI)

Tanggal: 2026-10-11 · Gate: §3a (brainstorm) aktif · Metode: `brainstorm-ideas-existing`,
`identify-assumptions-existing` + paket §3b (`frontend-ui-engineering`, `web-design-guidelines`,
`design-taste-frontend`, `redesign-existing-projects`, `job-stories`, `test-scenarios`).

## Framing (user request)
"Kan jadi kayak Google Drive ya — bisa di-download juga dong, harusnya ada ikon
jangan memanjang gitu, dan lebih menarik aja uinya."

## Job story
Saat saya melihat baris di manifest, saya ingin mengenali tipe file sekilas dan
mengunduhnya tanpa membuka Telegram, supaya app ini terasa seperti gudang sungguhan
(bukan sekadar log).

## Pendekatan yang dipilih (ditanya ke user → "Manifest kaya + drawer detail")
1. **Manifest kaya + drawer detail (DIPILIH)** — list padat tetap identitas; tiap baris
   diberi tile glyph tipe berwarna (thumbnail asli untuk gambar), tombol unduh, dan
   ketuk baris → bottom-sheet preview/metadata/aksi.
2. Toggle grid ala Drive — ditolak: butuh endpoint thumb per file, paling berat.
3. Row kaya tanpa drawer — ditolak: tak ada preview/preview metadata.

## Mekanisme
- Gateway: `downloadFile(groupId, messageId, destPath)` → `getMessages` + `downloadMedia`.
  ** Jebakan ditemukan & diperbaiki**: angka polos positif diparse teleproto sebagai user;
  grup harus peer marked `-(1e12 + id)` format `-100<id>` → PeerChannel.
- Endpoint `GET /files/:id/download` (auth header Bearer **atau** `?token=` untuk
  `<img>`/link), stream dari temp file, `content-disposition: attachment` + nama UTF-8.
- Web: `location.href` (disposition attachment → browser unduh, nama asli);
  Native: `Linking.openURL`.
- Ikon: `fileType.ts` — ekstensi → (lucide glyph, warna palet, kind image?).
  Gambar → thumbnail `<Image>` dari endpoint yang sama (gagal → fallback glyph).
- Drawer: `Modal` bottom-sheet — preview, meta (baris/status/tanggal/topik/grup/pesan),
  UNDUH + TELEGRAM (`https://t.me/c/<groupId>/<messageId>`).
- Rail kategori jadi strip horizontal di layar < 720 px (responsif, mobile-first).

## Anti-AI-slop
- Palet TANPA warna baru: merah=pdf, hijau=gambar/lembar bentang, amber=video/kode,
  putih=audio, abu=arsip — semuanya dari `theme.ts`.
- Identitas "manifest gudang terminal gelap" dipertahankan (hairline, mono numerals,
  radius 0/4) — menambah affordance Drive, bukan menjiplak tampilan Drive.
- Microcopy tetap spesifik gudang ("GUDANG MASIH KOSONG", "TIDAK ADA PRATINJAU — …SIAP DIUNDUH").
- Empty/loading/error state tetap didesain; download punya feedback notice.

## Kebenaran & verifikasi (dijalankan)
- 57 test hijau (shared 20 + server 37; +3 test download: bearer, ?token=, 404/401).
- Typecheck 3 workspace 0; `expo lint` 0 error; expo export web sukses.
- Live nyata: curl bearer → PDF 200 + disposition; query-token → JPG 200;
  Playwright: manifest (tile+thumbnail+tombol), drawer terbuka, klik UNDUH →
  event download `foto-test.jpg` 40000 B identik upload; pencarian "pdf laporan juni"
  fresh → TIDAK ADA DI GUDANG (menyelesaikan simpangsiu "1 HASIL" = stale render).
