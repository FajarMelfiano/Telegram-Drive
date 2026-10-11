/** Diagnostik: unduh file live dari Telegram (lihat error asli). Jalankan dari server/: npx tsx scripts/dl-diag.ts */
import { createRealGateway } from '../src/telegram.js';
import { decrypt } from '../src/crypto.js';
import { initDb, getSession } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const db = initDb(config.DB_PATH);
const row = getSession(db);
if (!row?.session_enc) throw new Error('Tidak ada sesi tersimpan');
const apiHash = decrypt(row.api_hash_enc, config.TURNO_SECRET_KEY);
const session = decrypt(row.session_enc, config.TURNO_SECRET_KEY);
const gw = await createRealGateway(row.api_id, apiHash, session);
const g = gw as unknown as { downloadFile(a: number, b: number, c: string): Promise<string> };
try {
  const out = await g.downloadFile(3744174906, 3, '/tmp/opencode/diag-out.pdf');
  console.log('OK →', out);
} catch (err) {
  console.error('GAGAL:', err);
}
gw.destroy();
