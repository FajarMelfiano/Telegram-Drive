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
