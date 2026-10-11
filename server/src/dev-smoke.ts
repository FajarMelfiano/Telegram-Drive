/**
 * Server demo untuk smoke test browser — memakai buildApp + DB nyata
 * (parser, FTS, kategori, antrean sinkron) tapi gateway Telegram palsu.
 *
 * Jalankan: npx tsx src/dev-smoke.ts  → http://localhost:8792
 * Login di UI: API ID bebas, nomor bebas (+62…), kode OTP 12345.
 */
import { buildApp } from './app.js';
import { enqueueSync, getCategoryByKey, insertFile } from './db.js';
import type { ChannelInfo, MeInfo, SentFileResult, TelegramGateway } from './telegram.js';

const KEY = '1'.repeat(64);

class DemoGateway implements TelegramGateway {
  private channels = new Map<string, ChannelInfo>();
  private msg = 1000;

  async sendCode(): Promise<{ phoneCodeHash: string }> {
    return { phoneCodeHash: 'demo-hash' };
  }
  async signIn(_phone: string, _hash: string, code: string): Promise<{ twoFa: boolean }> {
    if (code === '00000') throw new Error('PHONE_CODE_INVALID');
    return { twoFa: false };
  }
  async checkPassword(): Promise<void> { /* menerima password apa pun */ }
  async getMe(): Promise<MeInfo> { return { id: 1, firstName: 'Muse', username: 'muse_demo' }; }
  async ensureCategoryChannel(title: string): Promise<ChannelInfo> {
    const found = this.channels.get(title);
    if (found) return found;
    const info = { channelId: -100_000 - this.channels.size, title };
    this.channels.set(title, info);
    return info;
  }
  async sendFileToChannel(channelId: number): Promise<SentFileResult> {
    return { messageId: this.msg++, channelId };
  }
  sessionString(): string { return 'demo-session'; }
  destroy(): void { /* no-op */ }
}

const app = buildApp({
  config: { TURNO_SECRET_KEY: KEY, MAX_FILE_BYTES: 50_000_000 },
  gatewayFactory: async () => new DemoGateway(),
});

// Isi manifest contoh supaya tampilan terisi saat smoke test
const db = app.db;
const seed = [
  { uid: 'seed-1', name: 'laporan akhir juni.pdf', ext: 'pdf', mime: 'application/pdf', size: 2_415_000, cat: 'dokumen', at: '2026-06-28T09:12:00.000Z' },
  { uid: 'seed-2', name: 'invoice vendor mei.pdf', ext: 'pdf', mime: 'application/pdf', size: 480_000, cat: 'dokumen', at: '2026-05-04T14:03:00.000Z' },
  { uid: 'seed-3', name: 'foto liburan bandung.jpg', ext: 'jpg', mime: 'image/jpeg', size: 5_120_000, cat: 'gambar', at: '2026-10-02T18:44:00.000Z' },
  { uid: 'seed-4', name: 'struk renovasi.png', ext: 'png', mime: 'image/png', size: 900_000, cat: 'gambar', at: '2026-09-19T07:30:00.000Z' },
  { uid: 'seed-5', name: 'wedding edit final.mp4', ext: 'mp4', mime: 'video/mp4', size: 412_000_000, cat: 'video', at: '2026-08-11T21:15:00.000Z' },
  { uid: 'seed-6', name: 'backup gudang.zip', ext: 'zip', mime: 'application/zip', size: 78_000_000, cat: 'arsip', at: '2026-07-01T03:00:00.000Z' },
];
let msgId = 500;
for (const s of seed) {
  const cat = getCategoryByKey(db, s.cat)!;
  const file = insertFile(db, {
    fileUid: s.uid, name: s.name, ext: s.ext, mime: s.mime, size: s.size,
    uploadedAt: s.at, categoryId: cat.id, channelId: -100_000, messageId: msgId++,
  });
  enqueueSync(db, file.id);
}

const PORT = Number(process.env.SMOKE_PORT ?? 8792);
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`[demo] server demo jalan di http://localhost:${PORT} — OTP: 12345`);
