# Telegram Drive

Gudang pribadi di atas akun Telegram: unggah file → otomatis terklasifikasi ke channel
per kategori ("Drive · Gambar", "Drive · Dokumen", …) → tercatat di manifest (SQLite)
→ tersinkron ke Google Sheets + file `.xlsx` → dicari dengan query bahasa sehari-hari
("pdf laporan juni", "gambar bulan lalu").

## Struktur

```
shared/        parser query & classifier file (murni, diuji 20 unit test)
server/        gateway MTProto (teleproto) + API Fastify + SQLite/FTS5 + worker Sheets
apps/mobile/   aplikasi Expo (Android + Web) — Expo Router, tema arsip gelap
tasks/         rencana implementasi (plan.md) + status (todo.md)
```

## Menjalankan

### 1. Server

```bash
npm install
npm run build -w @td/shared

# buat .env dari contoh + isi secret (lihat .env.example)
cp .env.example server/.env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # isi TURNO_SECRET_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # isi JWT_SECRET

cd server && npx tsx src/index.ts        # http://localhost:8787
```

### 2. Aplikasi (Web / Android)

```bash
cd apps/mobile
npx expo start          # tekan w untuk web, a untuk Android emulator
```

Login memakai **API ID + API Hash** dari [my.telegram.org](https://my.telegram.org)
(API development tools) + nomor telepon + kode OTP (dan password 2FA bila aktif).

### 3. Sinkron Google Sheets (opsional)

1. Buat Google Sheet baru → Extensions → Apps Script → tempel
   `server/sheets-web-app.gs.example`.
2. Ganti `TOKEN` di script dengan string acak.
3. Deploy → New deployment → **Web app** (Execute as: Me, Access: Anyone).
4. Salin URL `/exec` ke `SHEETS_WEBHOOK_URL` di `.env`, dan token yang sama ke
   `SHEETS_TOKEN`.

Sinkron berjalan tiap 30 detik (batch ≤ 50 baris). Bila gagal/quota, baris tetap
di antrean dan dicoba lagi. Manifest `.xlsx` bisa diunduh kapan saja lewat
`GET /logs.xlsx`.

## Smoke test tanpa akun Telegram

```bash
cd server && npx tsx src/dev-smoke.ts     # server demo di :8787, OTP apa pun (mis. 12345)
cd apps/mobile && npx expo export --platform web && npx serve -s dist -l 8090
```

Buka `http://localhost:8090`, login dengan nomor `+62…` apa pun dan kode `12345`.

## Keamanan

- Session string & API hash disimpan **terenkripsi AES-256-GCM** (`TURNO_SECRET_KEY`).
- API aplikasi dilindungi JWT (`JWT_SECRET`); jangan bagikan `.env`.
- Ini userbot pribadi: mengunggah terlalu cepat bisa kena `FLOOD_WAIT` dari Telegram —
  server menghormati jeda tersebut.

## Endpoint API

| Method | Path | Fungsi |
| --- | --- | --- |
| POST | `/auth/start` | minta kode OTP |
| POST | `/auth/verify` | verifikasi OTP (→ 2FA bila perlu) |
| POST | `/auth/password` | password 2FA |
| GET | `/me` | profil + nomor |
| POST | `/files` | unggah file (multipart) → klasifikasi → channel → catat |
| GET | `/files?category=&limit=` | daftar manifest |
| GET | `/search?q=pdf%20juni` | pencarian pintar (parser + FTS5) |
| GET | `/categories` | kategori + jumlah file |
| GET | `/sync/status` | status antrean Sheets |
| GET | `/logs.xlsx` | unduh manifest Excel |

## Batasan MVP

- Upload berjalan satu per satu (anti flood); belum ada progres per-bagian.
- Modul WhatsApp belum ada — backend disiapkan lewat antrean `sync_queue`
  sebagai jembatan event (`file.uploaded`) untuk modul mendatang (Baileys/Cloud API).
- Upgrade pencarian ke LLM direncanakan setelah parser rule-based terbukti.
