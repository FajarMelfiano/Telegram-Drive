# Todo — Telegram Drive

## Phase A: Fondasi
- [x] Task 1: Scaffold monorepo (workspaces, tsconfig, git init)
- [x] Task 2: shared/ — classifier + query parser + unit test

## Phase B: Server inti
- [x] Task 3: DB schema + repo + test
- [x] Task 4: Telegram service (teleproto, mockable)
- [x] Task 5: API endpoints + JWT + integration test
- [x] Task 6: Sync worker (Sheets Apps Script + xlsx rolling) + test

## Phase C: Aplikasi Expo
- [x] Task 7: Expo Router + design tokens (arsip gelap, mono, amber) + navigasi
- [x] Task 8: Layar Login (API ID/Hash → OTP → 2FA)
- [x] Task 9: Manifest dashboard (rail kategori + upload document-picker + status sinkron)
- [x] Task 10: Chat search (parser chips + hasil)

## Phase D: Verifikasi akhir
- [x] Task 11: Smoke test nyata dengan akun Telegram user (api_id 38140538) —
      login OTP asli, 2 channel auto-created, 2 file terkirim & terverifikasi
      via riwayat channel (server/scripts/verify-live.ts)
- [x] Task 12: README + .env.example + laporan

## Phase E: Redesain penyimpanan (1 grup forum + topik/kategori)
- [x] Task 13: Gateway forum (ensureDriveGroup/ensureTopic/sendFileToTopic replyTo+topMsgId)
- [x] Task 14: DB migration v2 (drive_group singleton, topic refs reset, sesi utuh)
- [x] Task 15: Hapus channel "Drive · *" lama (cleanup-old-channels.ts) + verify-live
      membaca topik grup forum; live: grup "Telegram Drive" id 3744174906,
      topik General#1/Dokumen#2/Gambar#4, msg#3 topik=2 & msg#5 topik=4

## Phase F: Unduh file + ikon tipe + drawer detail (brainstorm-download-ui.md)
- [x] Task 16: Gateway downloadFile (peer marked -100<id> → getMessages + downloadMedia)
      + GET /files/:id/download (Bearer atau ?token=, attachment UTF-8) + 3 test
- [x] Task 17: UI — fileType.ts glyph per ekstensi (palet tanpa warna baru),
      ManifestRow (tile/thumbnail + tombol unduh + press state), FileDrawer
      (preview/meta/UNDUH/TELEGRAM), rail kategori responsif < 720 px
- [x] Task 18: Verifikasi — 57 test hijau, lint 0, export web, live curl 200,
      Playwright: drawer + download event 40000 B identik + search fresh konsisten

## Checkpoint
- [x] A: test shared hijau (20/20) + typecheck bersih
- [x] B: server start + 31 test hijau + curl smoke (/health, /categories→401)
- [x] C: expo export web sukses + smoke browser Chrome MCP
      (login OTP → manifest 6 baris → filter kategori → search "pdf laporan juni" → 1 hasil;
       tanpa error console baru; screenshot /tmp/opencode/smoke-*.png)
- [x] D: live smoke dengan akun Telegram asli (2026-10-11):
      OTP → login (id 7982240358) → upload PDF+JPG → channel "Drive · Dokumen"/
      "Drive · Gambar" terbuat → manifest 2 baris → search+filter OK → xlsx 6,9 KB →
      riwayat channel membaca file=ADA; sync Sheets pending=2 (webhook belum diisi)

## Phase F: Fondasi auth & data v2 (2026-10-11)
- [ ] Task 14: DB migration v3 (files+ kolom, albums, activity, devices, refresh_tokens, pairing_codes, kv, FTS)
- [ ] Task 15: Cookie httpOnly + refresh token + /devices
- [ ] Task 16: QR pairing login (single-use, TTL 5m)

## Phase G: Fitur drive server
- [ ] Task 17: rename+tags+delete+preview inline
- [ ] Task 18: batch + move kategori
- [ ] Task 19: ZIP stream
- [ ] Task 20: stats + activity + SSE

## Phase H: WhatsApp Baileys
- [x] Task 21: WaGateway state machine + auth terenkripsi + QR
- [x] Task 22: direct-chat handler → klasifikasi → topik → DB
- [x] Task 23: routes /wa/* + smoke script

## Phase I: UI mobile+web
- [ ] Task 24: LoginScreen mode QR pairing (web)
- [ ] Task 25: SettingsScreen (akun, koneksi, WA, penyimpanan, perangkat)
- [ ] Task 26: Manifest batch select + aksi massal + activity feed
- [ ] Task 27: FileDrawer v2 (preview, rename, tag, pindah, hapus)
- [ ] Task 28: AlbumScreen contact-sheet
- [ ] Task 29: secure-store + auto-refresh interceptor + polling events

## Phase J: Verifikasi & APK
- [ ] Checkpoint KJ: typecheck+test+lint+export+Playwright e2e+curl+WA live
- [ ] Task 30: build APK debug lokal
