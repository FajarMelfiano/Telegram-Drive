# Brainstorm — Antrian Unggah Tahan-Loss (3 Lapis)

> Metode: gerbang `brainstorm` + `idea-refine` + `identify-assumptions-existing`.
> Arah arsitektur dari user (3 lapis) sudah ditetapkan; dokumen ini merincikan
> mekanisme, asumsi, dan rencana verifikasi sebelum kode ditulis.

## Langkah 1 — Framing

1. **Masalah (bukan fitur):** unggah yang terputus — app dibunuh OS, pindah
   background, jaringan putus, tab ditutup — membuat file hilang dari antrean.
   User mengira "sudah terunggah" padahal tidak. Di produk *drive*, ini = **kehilangan
   data nyata**. Saat ini `pickAndUpload` hanya `Api.upload` sekali: gagal → hilang.
2. **User utama:** pemilik Telegram Drive personal (Android + web), unggah dari
   galeri/file manager, sering pindah app / layar mati di tengah unggah, teknis menengah.
3. **Sukses (verifikasi):**
   - (a) File yang sudah dipilih **tidak pernah hilang** walau app dibunuh/di-reload —
     dibuktikan: force-stop → buka ulang → terunggah otomatis.
   - (b) UI **mencerminkan keadaan nyata** (queued vs indexed), bukan asumsi.
   - (c) Retry **tidak menggandakan** file (idempoten).
4. **Bukan scope:** LLM auto-tag; sinkron Sheets (terpisah); background upload 100%
   andal di iOS (mustahil — dibatasi OS); resume byte-level upload (library tak sediakan
   utk upload); layar baru besar (hanya baris status di Manifest).

## Langkah 2 — Pendekatan inti (dipadu user jadi 3 lapis)

| # | Pendekatan | + | − | Risiko terbesar |
|---|-----------|---|---|------------------|
| A | **Antrian lokal persisten** (catat sebelum unggah, putar ulang saat buka app) | Andal lintas platform, tak dibatasi OS | Kompleksitas state + replay + sumber file | Sumber file hilang (cache/IDB) → stuck |
| B | **Background task OS** (task-manager + background-task + upload native) | Unggah lanjut sesaat setelah background | iOS ketat, web tak tersedia, min 15 mnt, butuh prebuild | Kerasa andal tapi tak 100% → kalah data kalau jadi satu-satunya |
| C | **Status via SSE/polling** (tahu queued vs indexed) | UI jujur, bukan mengira | Bukan pengaman data, hanya pelihat | Job disconnect → polling lambat |

**Pilihan: A utama (jaring pengaman) + B pelengkap (booster, native-only) + C kejujuran UI.**
A menang karena satu-satunya yang tak dibatasi OS dan berjalan di web juga; B/C tanpa A
tetap bisa kehilangan file. Tradeoff disadari: kompleksitas state layak untuk anti-hilang.

## Langkah 2b — Mekanisme & Sistem

### 1. Alur data
```
pick file (DocumentPicker / web <input>)
  → enqueue { clientUploadId(uuid), nama, sumber, state:queued } → penyimpanan lokal
  → worker replay (drain FIFO, 1 per waktu):
      resolve sumber → POST /files (+ clientUploadId)
        → server: dedup (user,clientUploadId)? kirim ulang file lama : simpan → Telegram topik → DB state=indexed
      → 2xx → dequeue (done) → update UI
      → gagal retryable → backoff → coba lagi nanti
  → status: state lokal (queued/uploading) + state server (indexed) → pill Manifest
```
Replay dipicu: (i) app ke foreground / dibuka; (ii) background task native (opportunistic);
(iii) job online kembali.

### 2. State & transisi (antrian)
```
queued ──mulai──> uploading ──2xx──> done (dequeue)
   ▲                  │
   └── gagal retryable (network/5xx, attempts++, backoff)
   ▲                  │
   └── app kill saat uploading → saat reload: reset ke queued (crash recovery)
uploading/queued ──4xx validasi / sumber hilang──> failed (permanent, aksi user)
queued ──URI tak resolving / Blob IDB hilang──> source_lost (pesan "pilih ulang")
```
Pemindah state = worker replay; transisi gagal ditangani per kasus (lihat 8).

### 3. Kontrak API
- **POST /files** (existing) **+ field `clientUploadId`** → server dedup: bila
  `(user_id, client_upload_id)` sudah ada → **return file lama** (200, bentuk sama),
  jangan buat duplikat. Butuh kolom `files.client_upload_id` + unique index (migrasi v5).
  *(Muat `api-contract` untuk perubahan kontrak ini.)*
- GET `/activity` + SSE `/events` (existing) → Layer 3.
- GET `/sync/status` (existing).

### 4. Integrasi luar
- **Telegram** (sendFileToTopic) — server-side, retry server yang urus.
- **Jaringan**: offline → tetap queued; timeout → retryable; FLOOD_WAIT → server map.
- **Storage lokal penuh / IDB quota** → enqueue gagal → user diberi tahu.

### 5. Algoritma inti
- **Replay worker**: FIFO, **sequensial 1 per waktu** (jangan saturasi uplink mobile);
  drain sekali per buka app; backoff per attempts (2ⁿ detik, cap ~60s) dalam sesi.
- **Dedup**: `clientUploadId` uuid v4 dibuat saat enqueue → kunci idempoten.
- **Resolusi sumber**: native `new File(uri).exists` (cache dir, `copyToCacheDirectory:true`);
  web → Blob di IndexedDB (lihat Q2).
- **Crash recovery**: saat load queue, entri `uploading` di-reset ke `queued`.

### 6. Model data
```
UploadQueueEntry {           // disimpan: AsyncStorage key 'td.uploadQueue'
  clientUploadId: string     // uuid, PK
  name, size, mime, ext, categoryHint
  sourceKind: 'native-cache' | 'web-idb'
  sourceRef: string          // cache uri  |  key IDB
  state: queued|uploading|done|failed|source_lost
  attempts: number, lastError?: string
  createdAt, updatedAt
}
// web Blob tersimpan terpisah di IndexedDB store 'tdFiles' (key = clientUploadId)
// server: files.client_upload_id TEXT + UNIQUE(user_id, client_upload_id) — migrasi v5
```
Integritas: PK uuid unik; dequeue = entri dihapus (bukan ditandai) → tak menumpuk.

### 7. Keamanan mekanisme
- Queue lokal = metadata (bukan rahasia) → AsyncStorage cukup (tak perlu SecureStore).
- Replay pakai token + **auto-refresh interceptor (sudah ada)**.
- `clientUploadId` di-scope per user di server (validasi kepemilikan) → user tak bisa
  menimpa file user lain lewat id acak.

### 8. Kegagalan (per langkah alur)
| Langkah gagal | Yang user lihat | Data konsisten? | Bisa ulang? |
|---|---|---|---|
| Pick batal | tak ada entri | ya | — |
| Enqueue gagal (storage penuh) | pesan error, file belum masuk antrian | ya (tak setengah jadi) | ya |
| Network putus saat replay | tetap "ANTRIAN", backoff | ya | otomatis |
| Server 5xx | retryable, tetap antrian | ya | otomatis |
| Server 4xx validasi | `failed`, aksi "coba/pilih ulang" | ya | manual |
| Response hilang setelah server terima | retry → kena dedup → tak duplikat | ya | otomatis |
| Sumber hilang (cache/IDB) | `source_lost`, "file asli tak ada, pilih ulang" | ya | manual |
| Token expired saat replay | auto-refresh → lanjut | ya | otomatis |

## Langkah 3 — Rencana Anti-AI-Slop (UI)
- **Identitas**: konsisten dgn "manifest gudang terminal gelap" yang sudah ada — bukan
  gaya baru.
- **Sistem visual**: pakai `theme.ts` yang ada (tak ada token baru). State pill +
  `stateColor` sudah ada → state antrian (`queued=greyState`, `uploading=amber`,
  `failed=red`, `source_lost=red`).
- **Pola**: Manifest footer sudah ada pill sinkron; **tambah blok "ANTRIAN LOKAL"** di
  atas daftar saat ada item → tiap baris: nama, state, progres %, aksi batal/pilih ulang.
  Empty = blok tak tampil; loading = replay spinner; error = `failed/source_lost` dengan
  aksi. Progress native dari `UploadTask.onProgress`; web tanpa progress upload → teks saja.
- **Checklist larangan**: ikon lucide (bukan emoji), tak ada placeholder, hierarki jelas
  (antrian = hal paling menonjol saat ada), empty/loading/error state didesain.

## Langkah 4 — Rencana Kebenaran
**Edge cases (≥5):** (1) kill app saat `uploading` → reset `queued`; (2) sumber hilang
→ `source_lost` bukan retry tanpa henti; (3) double-tap unggah → dedup `clientUploadId`;
(4) offline saat replay → tetap queued + backoff; (5) token expired → auto-refresh;
(6) server terima tapi response hilang → retry kena dedup; (7) nama unicode aneh → server
UTF-8 (sudah); (8) IDB quota web terlampaui → enqueue gagal dgn pesan.
**Failure modes:** jaringan (timeout/retry), FLOOD_WAIT (server map), storage penuh,
IDB quota.
**Pre-mortem (3):** (a) replay ganda → **duplikat file** → cegah unique index
`(user_id, client_upload_id)` + test; (b) antrian **tak terlihat user** (silent) → tampil
jelas di Manifest; (c) background task **crash loop** → try/catch + batas attempts +
unregister saat logout.
**Keamanan:** token utk replay, clientUploadId scoped per user, validasi server.
**Skalabilitas:** antrean ratusan file → drain bertahap (sequensial), hindari burst;
manifest query tetap terbatas (limit 200).

## Langkah 5 — Rencana Verifikasi (bukti, bukan klaim)
- Typecheck server + mobile, `expo lint`, server `vitest` (+ test baru: dedup
  `clientUploadId` mengembalikan file sama TANPA duplikat; migrasi v5).
- Unit test logika state antrian (ekstrak reducer murni → transisi queued/uploading/
  failed/source_lost teruji).
- Smoke manual (bukti): (i) pick file → **force-stop** → buka ulang → terunggah otomatis
  (log replay); (ii) mode offline → queued → online → drain; (iii) POST `clientUploadId`
  sama 2× via curl → `file.id` sama; (iv) web reload → replay dari IndexedDB.
- Screenshot Manifest memperlihatkan blok "ANTRIAN LOKAL" + state berubah queued→indexed.

## Asumsi Berisiko (identify-assumptions-existing)
| Asumsi | Area | Yakin | Tes |
|---|---|---|---|
| Sumber file (cache/IDB) masih ada saat replay | Feasibility | Medium | force-stop + buka ulang; cek `File.exists` |
| Dedup `clientUploadId` mencegah ganda | Feasibility | Medium (butuh migrasi) | curl 2× same id → id sama |
| Background task native jalan cukup utk bantu | Feasibility | Low (OS ketat, web tak ada) | `triggerTaskWorkerForTestingAsync` (dev) |
| User paham beda "antrian" vs "terindex" | Usability | High | lihat pill Manifest |
| Antrean lokal benar2 mencegah hilang (nilai utk user) | Value | High | skenario kill app |

## Pertanyaan Terbuka (diputuskan user sebelum implementasi)
- **Q1 Urutan**: Layer 1+3 dulu (safety net lintas platform, bisa diverifikasi sekarang)
  → Layer 2 (native-only) belakangan? Atau sekali jalan semua?
- **Q2 Web**: replay file web lintas-reload via Blob di IndexedDB (kuat, kompleks +
  risiko quota) vs cukup dalam-sesi (sederhana)?
- **Q3 Server**: tambah dedup `clientUploadId` (migrasi v5, cegah duplikat) vs tanpa
  (risiko file ganda saat retry)?
