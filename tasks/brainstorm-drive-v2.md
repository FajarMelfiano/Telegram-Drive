# Brainstorm — Telegram Drive v2 (Drive-fitur penuh, WA, QR login, APK)

Tanggal: 2026-10-11 · Status: DISETUJUI user (P0) via 4 keputusan:
Baileys linked-device · Cookie httpOnly + auto-refresh · Semua fitur drive + album · Bersihkan cache + build APK lokal.

---

## Langkah 1 — Framing

**Masalah (bukan fitur):**
1. File tersebar di Telegram tanpa kendali drive-like: tak bisa hapus/pindah/rename dari app, tak ada preview, tak ada album, tak ada statistik.
2. Login ulang menyusahkan — sesi harus melekat (cookie/keystore), plus opsi login web tinggal scan QR dari HP yang sudah login.
3. File masuk lewat WhatsApp direct chat hilang tak terindeks — padahal itu alur dapat-terima utama.
4. App web & mobile terpisah — perlu satu sistem tersinkronisasi lintas perangkat.

**User utama:** Muse (personal, sedikit user). Mobile Android + web desktop. Teknis: tinggi.

**Success criteria:**
1. Kirim file via WhatsApp direct chat → otomatis masuk topic kategori Telegram Drive + terindeks & searchable di app (bukti: live test).
2. Login web via scan QR dari mobile sesi aktif → web masuk sesi sama, data sinkron (bukti: Playwright end-to-end).
3. Session bertahan: tutup app/browser, buka lagi → tetap login (cookie httpOnly web, keystore native).
4. Semua fitur drive (upload, download, preview, delete, move, rename, tag, batch, album, stats, activity) berfungsi di web+mobile, semua test hijau, lalu APK ter-build.

**Bukan scope:**
- WhatsApp Cloud API resmi (tidak bisa akses direct chat).
- iOS build.
- Multi-tenant / banyak user.
- LLM search (tetap rule-based).
- WebAuthn passkey native (web-only passkey = opsional menyusul).

---

## Langkah 2 — Divergensi (3 pendekatan)

### S1. Integrasi WhatsApp
- **A. Baileys linked-device** (DIPILIH): HP scan QR → socket seperti WhatsApp Web. Realtime `messages.upsert`, media di-download → classifyFile → kirim ke topik kategori.
  - +: gratis, realtime, tanpa akun bisnis. −: ToS tidak resmi, risiko ban; library community.
  - Risiko terbesar: perubahan protokol / ban nomor. Mitigasi: nomor sekunder disarankan; koneksi bisa dicabut kapan saja; gagal koneksi tidak menggoyang inti app (WhatsApp = modul terpisah).
- **B. WhatsApp Business Cloud API**: resmi tapi tidak bisa baca file direct chat personal → syarat user tak terpenuhi.
- **C. Forward manual ke bot**: tidak otomatis, tidak realtime.

### S2. Login web dari mobile (QR)
- **A. Pairing code via QR** (DIPILIH): web tampilkan QR berisi pairing code pendek; mobile login scan; server tukar code → token web.
  - +: token tidak pernah lewat QR (QR hanya code sekali-pakai, TTL 5 menit). −: butuh endpoint polling.
- **B. QR langsung berisi JWT**: cepat tapi token sensitif tergambar di layar & bisa screenshot → risiko keamanan.
- **C. Login manual ulang di web**: tidak memenuhi syarat "tinggal scan".

### S3. Session persistence
- **A. Cookie httpOnly + auto-refresh** (DIPILIH): web session di cookie httpOnly + sliding refresh; native token di keystore + refresh.
  - +: aman XSS, transparan bagi user. −: butuh mekanisme refresh & logout per-device.
- **B. localStorage token** (status quo web): mudah tapi rentan XSS — skill keamanan melarang.
- **C. Passkey semua platform**: butuh native module, waktu paling lama; ditunda.

---

## Langkah 2b — Mekanisme & Sistem

### Alur data utama
```
WhatsApp direct chat ──Baileys──▶ waHandler ──classifyFile──▶ sendToTopic (Telegram grup forum)
                                              ──▶ insertFile (SQLite) ──▶ sync_queue ──▶ Sheets
Telegram send (app) ──POST /files── sendToTopic ──▶ insertFile ──▶ sync_queue
App/web ──GET /files, /search── SQLite (source of truth)
Unduh ──GET /files/:id/download── gateway.downloadFile ──▶ stream
```

### State & transisi
- `wa_connection`: `disconnected → connecting → qr_ready → linked → reconnecting | failed` — Baileys `connection.update` yang memindahkan state; QR expire → `qr_ready` baru; `loggedOut` → `disconnected` + hapus auth state.
- `file.state`: `indexed → uploaded → synced | failed` (sudah ada; delete = hard delete + pesan Telegram dihapus).
- `pairing`: `pending → claimed | expired` (TTL 5 menit, single-use).

### Kontrak API (baru / berubah)
Auth & device:
- `POST /auth/pairing` (auth) → `{ code, expiresIn }` — buat pairing code untuk web.
- `GET /auth/pairing/:code` (tanpa auth) → `{ status: 'pending' | 'claimed', token? }` — polling web.
- `POST /auth/pairing/:code/claim` (dengan code) → set cookie httpOnly + `{ token }`.
- `POST /auth/login` (berubah) → set cookie httpOnly selain mengirim `{ token }` (kompatibel mobile).
- `POST /auth/refresh` (cookie/bearer) → token baru (sliding 30d).
- `GET /devices`, `DELETE /devices/:id` — daftar sesi + logout per-device.

Files (CRUD drive-like):
- `PATCH /files/:id` — `{ name?, tags? }` rename/tag (name = tampilan; caption Telegram ikut diganti bila ada koneksi).
- `DELETE /files/:id` — hapus baris DB + `deleteMessages` Telegram.
- `POST /files/batch` — `{ action: 'delete' | 'move' | 'tag', ids: [], payload }` hasil per-id `{ id, ok, error? }`.
- `PATCH /files/:id/category` — move: download ulang → kirim ke topik baru → hapus pesan lama → update DB (atomik via urutan: insert baru dulu, hapus lama sesudah sukses).
- `GET /files/:id/preview` — stream inline (content-disposition: inline) untuk gambar/audio/video/pdf.
- `GET /files/zip?ids=1,2,3` — arsip ZIP stream (batch download).

Album:
- `GET/POST /albums`, `PATCH/DELETE /albums/:id`, `POST /albums/:id/files` `{ fileIds }`, `DELETE /albums/:id/files/:fileId`.
- DB: `albums(id, name, created_at)`, `album_files(album_id, file_id, position)` — album = koleksi manual (filter: file image/video), bukan topik baru (topik = kategori klasifikasi otomatis).

Stats & activity:
- `GET /stats` → `{ totalFiles, totalBytes, byCategory[], byExt[], storageSource: 'telegram' }`.
- `GET /activity?limit=50` — log `activity(id, type, detail_json, created_at)`: `file.uploaded`, `file.deleted`, `file.moved`, `wa.linked`, `wa.file_received`, dll.
- `GET /events` (SSE) — realtime: `file.new`, `wa.status`, `sync.done` (web EventSource; mobile polling 10s sebagai fallback).

WhatsApp:
- `GET /wa/status` → `{ state, qr?, phone? }`.
- `POST /wa/connect` → mulai koneksi, balik `{ state }` (QR menyusul via status/SSE).
- `POST /wa/disconnect` → logout + hapus auth state.

### Integrasi luar
- **Telegram (teleproto)**: sudah stabil. Grup hilang → auto-recreate (sudah ada).
- **Baileys**: auth state disimpan terenkripsi (AES-GCM, secret sama) di `wa_auth` DB; timeout koneksi 30s; auto-reconnect backoff 5s→60s; `loggedOut` = perlu scan ulang (user diberi tahu via status).
- **Google Sheets**: tak tersentuh (sync_queue tetap).

### Algoritma inti
- **Klasifikasi WhatsApp**: nama file + mime → `classifyFile` (sudah ada di shared). Media tanpa nama (foto) → pakai mime + timestamp → `gambar`/`video`/`audio`.
- **Dedup WhatsApp**: key `wa:<chatJid>:<msgId>` masuk `file_uid` → `INSERT OR IGNORE` idempoten.
- **Move kategori**: download ke temp → `sendFileToTopic(topikBaru)` → `deleteMessages(pesanLama)` → update DB. Kalau gagal di tengah: file baru tetap ada (duplikat aman, user bisa hapus manual) — pilih konsistensi "jangan pernah kehilangan file".
- **ZIP stream**: `archiver`-style manual ZIP (local file header + stream) atau dependency `archiver`; file di-download satu per satu dari Telegram ke temp, di-stream, didelete.
- **Batch**: loop serial dengan hasil per-id (jangan gagal semua karena satu gagal).
- **Auto-refresh token**: JWT 30d + `POST /auth/refresh` dipanggil app saat <7 hari sisa (web via interceptor 401-retry; native via hook sama).

### Model data (migrasi v3)
- `files`: + `display_name TEXT` (rename tampilan), `tags TEXT` (JSON array), `source TEXT DEFAULT 'telegram'` (`telegram | whatsapp`), `chat_jid TEXT`, `wa_msg_id TEXT`.
- Tabel baru: `albums`, `album_files`, `activity(id, type, detail TEXT, created_at)`, `devices(id, user_agent, last_seen, created_at)`, `refresh_tokens(id, token_hash, device_id, expires_at, revoked)`, `pairing_codes(code, expires_at, claimed_at)`.
- FTS5: index `name + display_name + tags` (rebuild trigger).
- `wa_auth` disimpan di tabel `kv` terenkripsi.
- Index: `files(source)`, `activity(created_at)`.

### Keamanan mekanisme
- Cookie: `httpOnly`, `sameSite=lax`, `secure` di prod, `maxAge=30d`; value = JWT (sudah HS256).
- `?token=` untuk `<img>` tetap (personal-use tradeoff, sudah didokumentasikan) — token disimpan web hanya di cookie utama; `?token=` hanya untuk URL preview yang dibangun sesi itu.
- Pairing code: random 8 char base32, TTL 5 menit, single-use, rate-limited (5 kode/menit).
- Refresh token: hash SHA-256 di DB, rotasi saat refresh, revoke per-device saat logout.
- Validasi semua body baru dengan zod; delete/move butuh auth; error tak pernah bocorkan stack.
- Baileys auth state terenkripsi at-rest (AES-GCM).

### Kegagalan (tiap langkah)
- WA down → status `failed` di Settings, app inti tetap jalan; file Telegram tak terpengaruh.
- Telegram flood-wait saat move → hasil per-id `FLOOD_WAIT`, coba lagi nanti.
- ZIP timeout → stream putus → client dapat error, tak ada file rusak tersimpan.
- Pairing expired → web dapat `expired`, tampilkan QR baru.

---

## Langkah 3 — Anti-AI-Slop

**Identitas:** "konsol arsip gudang" — sudah ada & dipertahankan: zinc-950 near-black, satu aksen amber label kuning gudang, mono numerals, hairline grid, radius 0 kontainer / 4 kontrol / pill chip.

**Sistem visual (lanjutan, token ada):** warna `#0B0C0E` base, amber `#E8A33D` aksen tunggal, green/red/greyState status; fontSize xs→xxl; space(n)=4n; ikon lucide stroke 1.5.

**Pola interaksi baru:**
- Settings = daftar ledger bergaris (bukan kartu seragam): seksi "AKUN", "KONEKSI", "WHATSAPP", "PENYIMPANAN", "PERANGKAT".
- Album = grid thumbnail rapat (contact-sheet) dengan judul mono di bawah — bukan kartu rounded.
- Batch mode: long-press baris → mode select, app bar berubah jadi "N TERPILIH · PINDAH · HAPUS · UNDUH".
- Empty state tiap layar ada (contoh album: "BELUM ADA ALBUM — Kelompokkan foto & video di sini.").
- Microcopy spesifik: "TERSAMBUNG · NOMOR +62•••", "PINDAI QR INI DARI HP YANG SUDAH MASUK", "FILE DIHAPUS DARI GUDANG & TELEGRAM".

**Checklist larangan:** tanpa emoji sebagai ikon; tanpa placeholder; tanpa gradient ungu; hierarki jelas per layar; empty/loading/error state terdesain; tes "AI mana pun bisa buat ini?" → jawab dengan keputusan spesifik (ledger settings, contact-sheet album, chip parser, status mono).

---

## Langkah 4 — Rencana Kebenaran

**Edge cases (min 5):**
1. Kirim foto WA tanpa nama file → fallback nama `wa-<timestamp>.<ext>`.
2. File > MAX_FILE_BYTES dari WA → tolak dengan log `activity(wa.file_rejected)`, pesan ke user di status.
3. Rename ke string kosong / spasi → 422 VALIDATION.
4. Batch berisi id duplikat / id tidak ada → hasil per-id, yang tak ada = `NOT_FOUND`.
5. Move kategori saat Telegram flood-wait → hasil `FLOOD_WAIT` + retryAfter, file lama tidak dihapus.
6. QR pairing dipakai 2x → kedua kalunya `410 PAIRING_CONSUMED`.
7. Cookie dicuri/replay → JWT tetap; mitigasi: logout per-device mencabut refresh; token utama tetap 30d (personal tradeoff, terdokumentasi).
8. Unicode nama file (emoji, Arab) → content-disposition UTF-8 sudah ditangani; ZIP pakai UTF-8 flag.
9. WhatsApp reconnect loop → backoff + status `reconnecting`, tak membombardir.

**Failure modes:** Telegram down → semua operasi file error ramah (sudah ada mapping). SQLite WAL. Temp file selalu di-cleanup `finally`.

**Pre-mortem (3 skenario gagal):**
1. Baileys tak kompatibel Node 26 / breaking change → uji smoke `wa-smoke.ts` link QR dulu sebelum rakit UI; gagal = fitur WA dikarantina, rilis lain tetap jalan.
2. APK gagal build (SDK kurang / gradle) → siapkan `sdkmanager` install build-tools+platforms; kalau tetap gagal, laporkan blocker spesifik, jangan klaim sukses.
3. QR login race (web reload saat claim) → pairing single-use atomik di SQLite transaction.

**Keamanan:** semua route baru `preHandler: requireAuth`; zod di boundary; cookie flags; token hash; rate-limit pairing; tak ada secret di log.

**Skalabilitas:** personal scale — list limit 200, batch ≤ 50 id, ZIP ≤ 20 file per request; FTS tetap.

---

## Langkah 5 — Rencana Verifikasi (bukti, bukan klaim)

1. `npm run typecheck` → 0 error (3 workspace + shared).
2. `npm test` → semua hijau (server ≥ 37 + baru; shared 20; mobile n/a).
3. `npx expo lint` → 0 error; `expo export --platform web` sukses.
4. Playwright web: login → manifest → upload → rename → tag → move → preview inline → select batch → hapus → buat album → tambah file → stats → settings → QR pairing flow (mobile approve via API) → web ter-login cookie → sinkron manifest identik. Screenshot tiap langkah.
5. Curl: cookie `HttpOnly` terlihat di header; `/files/:id/preview` `content-disposition: inline`; ZIP valid (unzip -t).
6. WA live (butuh HP user scan): `wa-smoke.ts` → kirim foto dari akun WA lain → file muncul di manifest sumber WhatsApp.
7. APK: `./gradlew assembleDebug` → APK ada, ukuran wajar, `aapt dump badging` valid.
