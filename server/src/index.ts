import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { startSyncWorker } from './sync.js';

const config = loadConfig();
await mkdir(dirname(config.DB_PATH), { recursive: true });

const app = buildApp({ dbPath: config.DB_PATH, config });

const stopWorker = startSyncWorker(app.db, config, fetch, (r) => {
  if (r.failed) console.warn('[sync] batch gagal dikirim ke Sheets — akan dicoba lagi');
  else if (r.sent > 0) console.log(`[sync] ${r.sent} baris terkirim ke Sheets`);
});

app.addHook('onClose', async () => stopWorker());

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`Telegram Drive server jalan di http://localhost:${config.PORT}`);
