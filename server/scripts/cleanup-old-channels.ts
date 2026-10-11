/**
 * Hapus channel test lama hasil smoke (Drive · Dokumen / Drive · Gambar).
 * HANYA channel broadcast NON-megagroup dengan judul diawali "Drive · " —
 * grup forum "Telegram Drive" tidak tersentuh.
 * Jalankan: TURNO_SECRET_KEY=... npx tsx scripts/cleanup-old-channels.ts
 */
import { initDb, getSession } from '../src/db.js';
import { decrypt } from '../src/crypto.js';
import tp from 'teleproto';

const KEY = process.env.TURNO_SECRET_KEY!;
const db = initDb('./data/telegram-drive.sqlite');
const row = getSession(db);
if (!row?.session_enc) throw new Error('session tidak ditemukan — belum login');

const client = new tp.TelegramClient(
  new tp.sessions.StringSession(decrypt(row.session_enc, KEY)),
  row.api_id,
  decrypt(row.api_hash_enc, KEY),
  { connectionRetries: 5 },
);
await client.connect();

const targets: Array<{ id: number; title: string; entity: unknown }> = [];
for await (const dialog of client.iterDialogs()) {
  const e = dialog.entity as unknown as {
    className?: string; title?: string; id: bigint | number; megagroup?: boolean;
  };
  if (e.className === 'Channel' && !e.megagroup && e.title?.startsWith('Drive · ')) {
    targets.push({ id: Number(e.id), title: e.title!, entity: dialog.entity });
  }
}

if (!targets.length) {
  console.log('Tidak ada channel test lama — sudah bersih.');
} else {
  for (const t of targets) {
    await client.invoke(new tp.Api.channels.DeleteChannel({ channel: t.entity as never }));
    console.log(`DIHAPUS: "${t.title}" (id ${t.id})`);
  }
}

// Pastikan grup forum tidak ikut terhapus
let drive = false;
for await (const dialog of client.iterDialogs()) {
  const e = dialog.entity as unknown as { className?: string; title?: string; megagroup?: boolean };
  if (e.className === 'Channel' && e.megagroup && e.title === 'Telegram Drive') drive = true;
}
console.log(`Grup "Telegram Drive": ${drive ? 'masih ada ✓' : 'tidak ada (belum pernah dibuat / ikut terhapus!)'}`);
client.disconnect();
