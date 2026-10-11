# Implementation Plan: Telegram Drive

## Overview
Aplikasi Expo (Android + Web) yang mengubah akun Telegram user menjadi "personal drive":
file yang di-upload otomatis terklasifikasi ke channel per kategori, tercatat di DB +
Google Sheets (via Apps Script), dan bisa dicari lewat search pintar berbasis parser
rule-based (kategori, nama, ekstensi, tanggal). Backend Node menampung koneksi MTProto
(teleproto) sebagai gateway; Expo jadi UI tipis.

## Architecture Decisions
- **Backend gateway (Node + teleproto)**: Telegram client di server — session aman terenkripsi, Android & Web pakai API yang sama. (Keputusan user.)
- **DB = source of truth, Sheets = mirror sinkron berkala** + file `.xlsx` rolling. (Idempoten via file_id.)
- **Parser search di `shared/`** (pure function) supaya bisa dites tanpa server.
- **Monorepo npm workspaces**: `shared/`, `server/`, `apps/mobile` (Expo, target android + web).
- **Stack server**: Fastify + TypeScript, better-sqlite3 (FTS5), zod, jose (JWT), ws, exceljs.
- **Auth**: api_id/api_hash + phone + OTP → session string terenkripsi AES-GCM at-rest → JWT app.

## Task List

### Phase A: Fondasi
- [ ] Task 1: Scaffold monorepo (workspaces, tsconfig, git init, plan docs)
- [ ] Task 2: `shared/` — tipe + classifier (mime→kategori) + query parser (id/en) + unit test
- **Checkpoint A**: `npm test` di shared hijau, typecheck bersih.

### Phase B: Server inti
- [ ] Task 3: DB schema (users, tg_sessions, categories, files, FTS5, sync_queue) + repo + test
- [ ] Task 4: Telegram service (teleproto): auth flow, ensureChannel, upload — interface disuntik, mockable
- [ ] Task 5: API endpoints: /auth/*, /categories, /files (upload), /search, /me + JWT middleware + integration test (mock TG)
- [ ] Task 6: Sync worker: queue → Google Apps Script web app + xlsx rolling export + test
- **Checkpoint B**: server start bersih, integration test hijau, `curl` smoke auth+search OK.

### Phase C: Aplikasi Expo
- [ ] Task 7: create-expo-app + design tokens (arsip gelap, mono, amber) + navigasi
- [ ] Task 8: Layar Login (api_id/hash → phone → OTP → 2FA)
- [ ] Task 9: Manifest dashboard (rail kategori + list file + status sync + upload dengan progress)
- [ ] Task 10: Chat search (query → hasil parser → list file)
- **Checkpoint C**: `expo export --platform web` sukses; smoke Playwright: login mock → upload → search.

### Phase D: Verifikasi akhir
- [ ] Task 11: Smoke test nyata dengan akun Telegram user (butuh kredensial) + bukti sinkron Sheets
- [ ] Task 12: README + .env.example + laporan 5 bagian

## Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| teleproto behavior beda dari GramJS | High | Spike login+upload di Task 4; interface mockable |
| Akun kena FloodWait | High | Upload berurutan (1 worker), backoff, hormati flood_wait |
| Apps Script quota harian | Med | Antrean + retry, xlsx rolling tetap jalan (degradasi) |
| Expo web vs Android beda perilaku | Med | Semua API dipanggil lewat klien TS bersama; test web dulu |
| Butuh kredensial Telegram untuk verifikasi live | Med | Verifikasi live di Phase D bersama user |

## Open Questions (untuk user, tidak memblokir)
- Nama app/prefix channel (default: "Drive · <Kategori>")
- Interval sinkron Sheets (default: 30 dtk / 50 baris, batched)

---

# Plan v2 (2026-10-11) — Drive-fitur penuh, WhatsApp, QR login, APK

Rujukan: `tasks/brainstorm-drive-v2.md` (scope disetujui P0).
Keputusan: cookie httpOnly + refresh token · QR pairing code (bukan token) · Baileys linked-device · album manual (bukan topik) · move kategori = insert baru dulu, hapus lama sesudah sukses.

## Task List

### Phase F: Fondasi auth & data (server)
- Task 14: DB migration v3 — kolom files (display_name, tags, source, chat_jid, wa_msg_id), tabel albums/album_files/activity/devices/refresh_tokens/pairing_codes/kv, FTS rebuild
- Task 15: Cookie httpOnly + refresh token (rotasi, hash, revoke per-device) + /auth/login cookie + /auth/refresh + /devices
- Task 16: QR pairing login — POST /auth/pairing + polling GET + claim (single-use, TTL 5m, rate limit)

### Phase G: Fitur drive (server)
- Task 17: PATCH /files/:id (rename+tags) + DELETE /files/:id (DB + Telegram) + preview inline
- Task 18: Batch endpoint (delete/move/tag) + move kategori (download→kirim topik baru→hapus lama)
- Task 19: ZIP stream batch download
- Task 20: GET /stats + GET /activity + SSE /events

### Phase H: WhatsApp (server)
- Task 21: WaGateway Baileys — state machine, auth state terenkripsi, QR via status/SSE, auto-reconnect
- Task 22: Handler pesan direct chat → classify → sendToTopic → insertFile(source=whatsapp) → activity + dedup + batas ukuran
- Task 23: Routes /wa/status|connect|disconnect + smoke script

### Phase I: UI mobile+web
- Task 24: LoginScreen web: mode QR pairing (tampil QR + polling)
- Task 25: SettingsScreen — akun, koneksi Telegram, WhatsApp (QR connect), penyimpanan/stats, perangkat (logout per-device), logout
- Task 26: Manifest — batch select mode (long-press), aksi pindah/hapus/unduh-zip, upload (sudah ada), activity feed
- Task 27: FileDrawer v2 — preview inline (gambar/pdf/audio/video), rename, tag editor, pindah kategori, hapus
- Task 28: AlbumScreen — contact-sheet grid, buat album, tambah/hapus file
- Task 29: Mobile: token di keystore (expo-secure-store), auto-refresh interceptor, polling /events

### Phase J: Verifikasi & APK
- Checkpoint KJ: typecheck 0 · semua test hijau · lint 0 · export web sukses · Playwright e2e (login QR, drive ops, album, batch, settings) · curl cookie/preview/zip · WA live smoke (butuh HP user)
- Task 30: Build APK debug lokal (sdkmanager build-tools+platforms, gradlew assembleDebug)

## Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Baileys tak kompatibel Node 26 | Med | smoke link QR dulu (Task 21 awal); WA dikarantina kalau gagal |
| APK build gagal (SDK kurang) | Med | install sdkmanager dulu; kalau gagal → laporkan blocker jujur |
| Move besar (392MB) lambat | Rendah | hasil per-id + retry manual; jangan pernah hapus lama sebelum baru sukses |
