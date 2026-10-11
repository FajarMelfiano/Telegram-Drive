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
