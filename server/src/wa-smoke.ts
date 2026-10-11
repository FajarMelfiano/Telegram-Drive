/**
 * Smoke test nyata WhatsApp Baileys — verifikasi kompatibilitas & kehidupan
 * socket, TANPA perlu scan QR (tidak mengirim pesan, tidak menunggu pairing).
 *
 * Apa yang diuji di sini (berbeda dari unit test yang memakai FakeWaGateway):
 *  1. Import Baileys sungguhan di Node berjalan (bukan mock).
 *  2. Konstruksi socket nyata dengan auth-store kita (initAuthCreds + SignalKeyStore).
 *  3. State machine mulai dari 'disconnected' → 'connecting'.
 *  4. Auth store terenkripsi (AES-GCM) menulis & membaca balik kredensial.
 *  5. Listener onStatus/onFile terpasang tanpa error.
 *
 * Kalau langkah ini gagal di Node 26, fitur WA dikarantina (lihat pre-mortem).
 *
 * Jalankan: npm run wa:smoke   (atau: npx tsx src/wa-smoke.ts)
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  BaileysWaGateway, EncryptedWaAuthStore, ensureWaDataDir,
  type WaGateway, type WaStatus,
} from './whatsapp.js';

const KEY = randomBytes(32).toString('hex');
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra = ''): void {
  const mark = cond ? '✓' : '✗';
  if (cond) passed++; else failed++;
  console.log(`  ${mark} ${name}${extra ? ` — ${extra}` : ''}`);
}

async function main(): Promise<void> {
  console.log('=== WhatsApp Baileys smoke test ===');
  console.log(`Node: ${process.version}\n`);

  // 1. Auth store terenkripsi: simpan → muat → cocok; clear → hilang.
  console.log('[1] Auth store terenkripsi AES-GCM');
  const dir = await mkdtemp(join(tmpdir(), 'wa-smoke-'));
  await ensureWaDataDir(dir);
  const store = new EncryptedWaAuthStore(join(dir, 'auth.json'), KEY);
  const sample = { creds: { me: { id: '62811:test' }, registered: true }, keyData: { 'pre-key': { '1': { public: 'abc' } } } };
  await store.save(sample);
  const loaded = await store.load();
  check('save → load memulihkan data persis', JSON.stringify(loaded) === JSON.stringify(sample));

  const wrongStore = new EncryptedWaAuthStore(join(dir, 'auth.json'), 'f'.repeat(64));
  check('kunci salah → load null (tidak crash, tidak bocor)', (await wrongStore.load()) === null);

  await store.clear();
  check('clear → load null', (await store.load()) === null);

  // 2. Gateway: konstruksi, listener, state awal, connect → connecting.
  console.log('\n[2] Gateway Baileys (konstruksi + state machine)');
  const gw: WaGateway = new BaileysWaGateway(store);
  const seen: WaStatus[] = [];
  gw.onStatus((s) => seen.push(s));
  let fileHandlerOk = true;
  try { gw.onFile(() => { /* noop */ }); } catch { fileHandlerOk = false; }
  check('onStatus/onFile terpasang tanpa error', fileHandlerOk);
  check('state awal disconnected', gw.status().state === 'disconnected');

  // Connect: karena auth kosong, Baileys akan minta QR → state 'qr_ready'.
  // Kita beri waktu singkat lalu hentikan (tidak menunggu pairing manusia).
  await gw.connect();
  await new Promise((r) => setTimeout(r, 2500));
  const st = gw.status();
  check(
    'connect menggerakkan state (connecting → qr_ready/link/reconnecting)',
    st.state !== 'disconnected',
    `state=${st.state}${st.qr ? ` qr=${st.qr.slice(0, 18)}…` : ''}`,
  );
  check('ada transisi status yang tercatat', seen.length > 0, `${seen.length} event`);

  // 3. Disconnect & destroy bersih.
  console.log('\n[3] Teardown');
  await gw.disconnect();
  check('disconnect → state disconnected', gw.status().state === 'disconnected');
  gw.destroy();
  check('destroy tidak error', true);

  console.log(`\n=== Hasil: ${passed} lulus, ${failed} gagal ===`);
  if (failed > 0) {
    console.error('SMOKE GAGAL — karantina fitur WhatsApp sebelum lanjut.');
    process.exitCode = 1;
  } else {
    console.log('SMOKE LULUS — Baileys kompatibel dengan Node ini.');
  }
  // eslint-disable-next-line no-process-exit
  process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
  console.error('SMOKE CRASH:', e);
  process.exit(1);
});
