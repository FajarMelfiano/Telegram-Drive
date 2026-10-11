# Brainstorm — Ganti Channel-per-Kategori → 1 Grup Forum + Topik

Tanggal: 2026-10-11 · Status: menunggu persetujuan scope
Skill terkait: `brainstorm` (gerbang), `brainstorm-ideas-existing`, `identify-assumptions-existing`, `verify`, `debugging-and-error-recovery`

## Langkah 1 — Framing

1. **Masalah**: Channel-per-kategori membuat 6 channel terpisah ("Drive · Gambar", …)
   di chat list Telegram user — berantakan. User ingin **satu wadah** ("community"-style):
   semua file dalam SATU chat, kategori jadi pilihan di dalamnya.
2. **User**: melfano — personal use (bukan SaaS), pakai app Expo (Android/web) + chat
   Telegram asli untuk browsing file.
3. **Kriteria berhasil** (verifiable):
   - Telegram menampilkan **1 grup** "Telegram Drive"; kategori = **topik** di dalamnya.
   - Upload tetap terotomasi ke topik yang benar & tercatat di manifest + FTS.
   - Typecheck 3 workspace bersih, 51/51 test hijau, live smoke ulang dengan bukti
     riwayat topik (file=ADA di topik yang benar).
4. **Bukan scope**: WhatsApp, pencarian LLM, perubahan Sheets/xlsx, redesign UI app
   (hanya copy bila menyebut "channel"), multi-akun.

## Langkah 2 — Divergensi (3 pendekatan)

| # | Ide | + | − | Risiko terbesar |
|---|---|---|---|---|
| A | **1 grup forum (`CreateChannel megagroup+forum`) + topik per kategori** | Tampilan persis yang diminta; API lengkap di teleproto; satu peer = ringkas | Bukan "Community" murni (topik, bukan channel terpisah) | Topik dibuat via API harus idempoten |
| B | Community asli (channel terpisah di-link) | Bentuk paling mirip kata "community" | **teleproto tak punya API create/link community** — harus raw TL/manual | Blokir; tak terverifikasi |
| C | Riset dulu baru putuskan | Aman | Menunda eksekusi tanpa perlu | Over-engineering |

**Pilihan user: A** (+ hapus 2 channel test lama). Menang karena satu-satunya yang
feasible end-to-end dengan bukti, dan tampilannya memenuhi deskripsi user
("satu chat, beberapa pilihan = kategori").

## Langkah 2b — Mekanisme & Sistem

### 1. Alur data (baru)
```
upload → classifyFile(mime/ext) → gateway.ensureCategorySlot(label)
        → [1] ensureDriveGroup: cari grup "Telegram Drive" di dialog (cache di DB)
              kalau tak ada → channels.CreateChannel(megagroup+forum)
        → [2] ensureTopic: messages.GetForumTopics → cocokkan judul
              kalau tak ada → messages.CreateForumTopic → rootMsgId (topMsgId)
        → [3] sendFile(grup, file, caption=nama, topMsgId=rootMsgId)
        → insertFile(channelId=groupId, messageId=msgId) → enqueueSync
```
Endpoint API **tidak berubah** — hanya makna kolom.

### 2. State & transisi
- Kategori: `pending_channel` → `ready` (topik siap) — dipertahankan agar UI tak berubah.
- Grup: disimpan sebagai singleton di tabel baru `drive_group`; kalau grup terhapus
  user (error PEER_ID_INVALID/CHANNEL_PRIVATE saat kirim) → reset cache → buat ulang.
- FLOOD_WAIT saat buat topik → mapped error 429 + retryAfter (mekanisme lama berlaku).

### 3. Kontrak API
Tidak ada perubahan bentuk response. `/categories[].channelId` = **topMsgId topik**
(bukan id grup), `channelTitle` = judul topik (= label kategori, mis. "Gambar").

### 4. Integrasi luar
Telegram (teleproto) satu-satunya dependensi baru. Tidak ada perubahan Sheets/xlsx.
Dua channel test lama dihapus via `channels.DeleteChannel` (irreversible — sudah
disetujui user; isinya hanya file test).

### 5. Algoritma inti
- **Idempoten**: cari topik by judul lewat `GetForumTopics` (sekali per kirim, murah)
  sebelum create. Cari grup by id di DB, fallback iterDialogs sekali lalu cache.
- **Urutan**: create topik berurutan (satu-per-satu upload) anti-flood, seperti sebelumnya.

### 6. Model data (migrasi `PRAGMA user_version`)
- v2: tabel `drive_group(id=1 CHECK, group_id, group_title, created_at)`.
- Reset `categories.channel_id/channel_title → NULL`, `state → 'pending_channel'`
  (nilai lama = id channel yang akan dihapus).
- Hapus baris `files` + `sync_queue` + FTS (data test menunjuk channel yang dihapus).
- **`tg_sessions` dipertahankan → user TIDAK perlu login OTP ulang.**

### 7. Keamanan
Tak berubah: JWT, AES-256-GCM session/api_hash. Penghapusan channel hanya bisa
dijalankan dari server lokal ber-`.env`.

### 8. Kegagalan
| Langkah gagal | Yang user lihat | Konsistensi | Retry |
|---|---|---|---|
| CreateGroup/Topic ditolak | error mapped (429/400) | tak ada baris file | ya, upload ulang |
| Kirim ke topik gagal setelah file tercatat sementara | error mapped | `finally` bersihkan file temp; tak ada insert | ya |
| Grup dihapus user | error mapped + cache auto-reset | manifest lama tetap, upload berikut buat grup baru | otomatis |
| Migrasi v2 di DB lama | startup gagal jelas | session selamat | manual (MVP: DB test) |

## Langkah 3 — Anti-AI-Slop (UI/UX)

- **Identitas**: tak berubah — "arsip/gudang digital" zinc-950 + amber `#E8A33D`,
  mono numerals, radius rules, tanpa shadow. Sistem visual yang sudah ada DIPAKAI ULANG.
- **Yang berubah hanya copy**: penyebutan "channel per kategori" → "satu grup, topik
  per kategori" di README + teks pendukung app (mis. empty state manifest).
- **Checklist**: tanpa emoji-icon, tanpa placeholder, tanpa gradient ungu, hierarki
  manifest-table tetap, empty/loading/error state tetap terdesain. Uji "AI mana pun
  bisa buat ini?" — tak berlaku karena UI tidak dirancang ulang; hanya konsistensi copy.

## Langkah 4 — Kebenaran

1. **Edge cases (≥5)**: (a) topik sudah ada → jangan dobel; (b) grup ada tapi bukan
   forum → tak terjadi (kita yang create), tapi guard `forum` flag; (c) judul kategori
   mengandung "·"/unicode → aman (parameterized invoke); (d) 2 upload cepat → jalur
   in-process serial; (e) DB lama belum termigrasi → user_version v2 sekali jalan;
   (f) file >2GB → limit lama berlaku.
2. **Failure modes**: Telegram down/timeout → connectionRetries 5 (teleproto),
   error mapped; Sheets kosong → queue menumpuk (by design, lama); xlsx lokal tetap.
3. **Pre-mortem**: (1) `CreateForumTopic` butuh flag tak tersedia di LAYER 230 →
   diuji live sebelum commit; (2) topik tak muncul di app Telegram user → verifikasi
   via `GetForumTopics` + iterDialogs; (3) migrasi menghapus session → tak ada (SQL
   eksplisit tidak menyentuh `tg_sessions`, diverifikasi test).
4. **Keamanan**: tak berubah dari baseline; API hash/session tetap terenkripsi.
5. **Skalabilitas**: personal use; iterDialogs di-cache (tidak per panggilan).

## Langkah 5 — Rencana Verifikasi (bukti, bukan klaim)

1. `tsc --noEmit` 3 workspace (mobile pakai `node --stack-size=32000`) → 0 error.
2. `vitest run` shared+server → **51/51 hijau** (termasuk test migrasi v2 baru).
3. Live smoke (akun asli, session lama tanpa re-login):
   a. 2 channel test lama **tidak ada lagi** di dialog (bukti: `DeleteChannel` OK + iterDialogs).
   b. Grup "Telegram Drive" ada, `GetForumTopics` tampil 6 topik (atau sesuai upload).
   c. Upload PDF+JPG → `verify-live.ts` v2 baca topik → `msg "laporan…pdf" file=ADA`
      di topik **Dokumen**, JPG di topik **Gambar**.
   d. `/search?q=pdf` → 1 hasil; `/files` → 2 baris; `/logs.xlsx` → 200.
4. Smoke browser (Chrome MCP): manifest + rail kategori tampil normal, tak ada
   console error baru; screenshot disimpan.
5. `git status` bersih setelah commit atomik.

## Risiko berisiko tinggi (dari identify-assumptions-existing)

| Asumsi | Keyakinan | Tes |
|---|---|---|
| `CreateForumTopic` jalan di LAYER 230 teleproto | Medium | Live create 1 topik sebelum integrasi penuh |
| `sendFile(topMsgId=…)` menaruh pesan di topik benar | Medium | Verifikasi riwayat topik via GetForumTopicsByID |
| Migrasi tak menyentuh session | High | Test unit eksplisit: session row selamat |
