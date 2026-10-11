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
- [ ] Task 11: Smoke test nyata dengan akun Telegram user (butuh api_id/hash/HP user)
- [x] Task 12: README + .env.example + laporan

## Checkpoint
- [x] A: test shared hijau (20/20) + typecheck bersih
- [x] B: server start + 31 test hijau + curl smoke (/health, /categories→401)
- [x] C: expo export web sukses + smoke browser Chrome MCP
      (login OTP → manifest 6 baris → filter kategori → search "pdf laporan juni" → 1 hasil;
       tanpa error console baru; screenshot /tmp/opencode/smoke-*.png)
