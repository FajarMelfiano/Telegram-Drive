/**
 * Verifikasi live: baca session tersimpan (terdekripsi) → tampilkan riwayat
 * 2 channel kategori, buktikan file sungguhan ada di Telegram.
 * Jalankan: npx tsx scripts/verify-live.ts
 */
import { initDb, getSession } from '../src/db.js';
import { decrypt } from '../src/crypto.js';
import tp from 'teleproto';

const KEY = process.env.TURNO_SECRET_KEY!;
const db = initDb('./data/telegram-drive.sqlite');
const row = getSession(db);
if (!row?.session_enc) throw new Error('session tidak ditemukan — belum login');

const apiHash = decrypt(row.api_hash_enc, KEY);
const session = decrypt(row.session_enc, KEY);

const client = new tp.TelegramClient(new tp.sessions.StringSession(session), row.api_id, apiHash, { connectionRetries: 5 });
await client.connect();
const me = await client.getMe();
console.log(`Masuk sebagai: ${me.firstName} (@${me.username ?? '-'}) id=${me.id}`);

// Kumpulkan entity channel dari dialog (resolve by judul, bukan raw id)
const channels = new Map<string, unknown>();
for await (const dialog of client.iterDialogs()) {
  const e = dialog.entity as { className?: string; title?: string };
  if (e.className === 'Channel' && e.title) channels.set(e.title, dialog.entity);
}
console.log(`Channel "Drive ·" terdeteksi di dialog: ${[...channels.keys()].filter((t) => t.startsWith('Drive')).join(', ') || '(tidak ada)'}`);

for (const title of ['Drive · Dokumen', 'Drive · Gambar']) {
  const entity = channels.get(title);
  if (!entity) { console.log(`\n== ${title} == TIDAK DITEMUKAN`); continue; }
  const msgs = (await client.getMessages(entity as never, { limit: 5 })) as unknown as Array<{
    id: number; message?: string; file?: unknown; date: string | number | Date;
  }>;
  console.log(`\n== ${title} — ${msgs.length} pesan terakhir ==`);
  for (const m of msgs) {
    console.log(`  msg#${m.id} [${String(m.date)}] "${(m.message ?? '').slice(0, 60)}" file=${m.file ? 'ADA' : 'tidak'}`);
  }
}
client.disconnect();
