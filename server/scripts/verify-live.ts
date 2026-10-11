/**
 * Verifikasi live: baca session tersimpan (terdekripsi) → tampilkan grup forum
 * "Telegram Drive", daftar topik, dan pesan terakhir tiap topik kategori —
 * buktikan file sungguhan ada di topik yang benar.
 * Jalankan: TURNO_SECRET_KEY=... npx tsx scripts/verify-live.ts
 */
import { initDb, getSession, getDriveGroup } from '../src/db.js';
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

const cached = getDriveGroup(db);
console.log(`Grup di cache DB: ${cached ? `${cached.groupTitle} (id ${cached.groupId})` : '(belum ada)'}`);

// Cari grup drive + 2 channel test lama di dialog
let driveGroup: unknown = null;
const oldChannels: Array<{ id: number; title: string }> = [];
for await (const dialog of client.iterDialogs()) {
  const e = dialog.entity as unknown as {
    className?: string; title?: string; id: bigint | number; megagroup?: boolean;
  };
  if (e.className !== 'Channel') continue;
  if (e.megagroup && e.title === 'Telegram Drive') driveGroup = dialog.entity;
  if (!e.megagroup && e.title?.startsWith('Drive · ')) {
    oldChannels.push({ id: Number(e.id), title: e.title! });
  }
}
console.log(`Grup "Telegram Drive" di dialog: ${driveGroup ? 'ADA' : 'TIDAK ADA'}`);
console.log(`Channel lama tersisa: ${oldChannels.length ? oldChannels.map((c) => c.title).join(', ') : '(tidak ada — bersih)'}`);

if (driveGroup) {
  const topics = (await client.getForumTopics(driveGroup as never, { limit: 100 })) as unknown as {
    topics: Array<{ className?: string; id: number; title: string }>;
  };
  const mine = topics.topics.filter((t) => t.className === 'ForumTopic');
  console.log(`\nTopik di grup (${mine.length}): ${mine.map((t) => `${t.title}#${t.id}`).join(' | ')}`);

  const msgs = (await client.getMessages(driveGroup as never, { limit: 10 })) as unknown as Array<{
    id: number; message?: string; file?: unknown; date: string | number | Date;
    replyTo?: { replyToTopId?: number; replyToMsgId?: number; forumTopic?: boolean };
  }>;
  console.log(`\nPesan terakhir di grup (${msgs.length}):`);
  for (const m of msgs) {
    const topId = m.replyTo?.replyToTopId ?? m.replyTo?.replyToMsgId ?? '-';
    console.log(`  msg#${m.id} topik=${topId} [${String(m.date)}] "${(m.message ?? '').slice(0, 50)}" file=${m.file ? 'ADA' : 'tidak'}`);
  }
}
client.disconnect();
