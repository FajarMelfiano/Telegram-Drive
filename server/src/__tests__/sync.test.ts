import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, ensureCategories, listCategories, insertFile, enqueueSync, getSyncStats, getCategoryByKey } from '../db.js';
import { syncOnce, buildXlsxBuffer, writeRollingXlsx } from '../sync.js';
import type { Database } from 'better-sqlite3';

let db: Database;

function seedFile(name: string, uid: string, messageId = 1): number {
  const cat = getCategoryByKey(db, 'dokumen')!;
  const f = insertFile(db, {
    fileUid: uid, name, ext: 'pdf', mime: 'application/pdf', size: 11,
    uploadedAt: '2026-10-11T10:00:00.000Z', categoryId: cat.id, channelId: -1, messageId,
  });
  enqueueSync(db, f.id);
  return f.id;
}

beforeEach(() => {
  db = initDb(':memory:');
  ensureCategories(db);
});

describe('syncOnce', () => {
  it('mengirim batch ke webhook dan menandai synced', async () => {
    seedFile('laporan.pdf', 'u1', 11);
    seedFile('invoice.pdf', 'u2', 12);
    let body: unknown = null;
    const fakeFetch = (async (_url: unknown, init: { body: string }) => {
      body = JSON.parse(init.body);
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;

    const res = await syncOnce(db, { SHEETS_WEBHOOK_URL: 'https://example.test/hook', SHEETS_TOKEN: 'tok' }, fakeFetch);
    expect(res).toEqual({ sent: 2, failed: false });
    expect((body as { rows: Array<{ nama: string }> }).rows.map((r) => r.nama).sort()).toEqual(['invoice.pdf', 'laporan.pdf']);
    expect(getSyncStats(db)).toEqual({ pending: 0, sent: 2 });
  });

  it('gagal (non-2xx) → baris tetap di antrean', async () => {
    seedFile('a.pdf', 'u3');
    const fakeFetch = (async () => new Response('quota exceeded', { status: 429 })) as unknown as typeof fetch;
    const res = await syncOnce(db, { SHEETS_WEBHOOK_URL: 'https://example.test/hook', SHEETS_TOKEN: '' }, fakeFetch);
    expect(res.failed).toBe(true);
    expect(getSyncStats(db).pending).toBe(1);
  });

  it('webhook belum dikonfigurasi → tidak error, antrean aman', async () => {
    seedFile('b.pdf', 'u4');
    const res = await syncOnce(db, { SHEETS_WEBHOOK_URL: '', SHEETS_TOKEN: '' });
    expect(res).toEqual({ sent: 0, failed: false });
    expect(getSyncStats(db).pending).toBe(1);
  });
});

describe('xlsx export', () => {
  it('menghasilkan buffer xlsx valid (header PK)', async () => {
    seedFile('laporan.pdf', 'u5');
    const buf = await buildXlsxBuffer(db);
    expect(buf.subarray(0, 2).toString('ascii')).toBe('PK');
  });

  it('menulis file rolling ke disk', async () => {
    seedFile('c.pdf', 'u6');
    const dir = await mkdtemp(join(tmpdir(), 'td-xlsx-'));
    const path = join(dir, 'logs.xlsx');
    await writeRollingXlsx(db, path);
    const { stat } = await import('node:fs/promises');
    expect((await stat(path)).size).toBeGreaterThan(0);
  });
});
