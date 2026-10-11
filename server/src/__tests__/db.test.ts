import { describe, it, expect, beforeEach } from 'vitest';
import type { Database } from 'better-sqlite3';
import {
  initDb, ensureCategories, listCategories, upsertCategoryTopic,
  insertFile, searchFiles, listFiles, enqueueSync, dequeueSyncBatch,
  markSynced, getSyncStats, saveSession, getSession, getDriveGroup, saveDriveGroup,
} from '../db.js';

let db: Database;

beforeEach(() => {
  db = initDb(':memory:');
});

describe('initDb + ensureCategories', () => {
  it('creates schema and seeds default categories', () => {
    ensureCategories(db);
    const cats = listCategories(db);
    expect(cats.map((c) => c.key).sort()).toEqual(
      ['arsip', 'audio', 'dokumen', 'gambar', 'lainnya', 'video'],
    );
    expect(cats[0]!.state).toBe('pending_channel');
  });

  it('is idempotent', () => {
    ensureCategories(db);
    ensureCategories(db);
    expect(listCategories(db)).toHaveLength(6);
  });
});

describe('upsertCategoryTopic', () => {
  it('stores topic id and marks ready', () => {
    ensureCategories(db);
    upsertCategoryTopic(db, 'gambar', 4321, 'Gambar');
    const cat = listCategories(db).find((c) => c.key === 'gambar')!;
    expect(cat.channelId).toBe(4321);
    expect(cat.state).toBe('ready');
  });
});

describe('drive_group singleton', () => {
  it('saves, reads, and clears the forum group cache', () => {
    expect(getDriveGroup(db)).toBeUndefined();
    saveDriveGroup(db, { groupId: -100777, groupTitle: 'Telegram Drive' });
    expect(getDriveGroup(db)).toEqual({ groupId: -100777, groupTitle: 'Telegram Drive' });
    saveDriveGroup(db, { groupId: -100888, groupTitle: 'Telegram Drive' });
    expect(getDriveGroup(db)!.groupId).toBe(-100888);
  });
});

describe('migrasi v2 (channel → grup forum)', () => {
  it('membersihkan data channel lama tapi MEMPERTAHANKAN session (tanpa login ulang)', () => {
    // 1. Bangun DB "lama" (berisi session + file + referensi channel), paksa user_version=1
    const tmp = `/tmp/td-mig-${Date.now()}.sqlite`;
    const old = initDb(tmp);
    saveSession(old, { apiId: 1, apiHashEnc: 'h', sessionEnc: 's', phone: '+62' });
    ensureCategories(old);
    upsertCategoryTopic(old, 'dokumen', 999, 'Drive · Dokumen');
    const catOld = listCategories(old).find((c) => c.key === 'dokumen')!;
    const fOld = insertFile(old, { fileUid: 'x', name: 'a.pdf', ext: 'pdf', mime: 'application/pdf', size: 1, uploadedAt: '2026-10-11T00:00:00.000Z', categoryId: catOld.id, channelId: 999, messageId: 2 });
    enqueueSync(old, fOld.id);
    old.pragma('user_version = 1'); // simulasi DB sebelum era grup forum
    old.close();

    // 2. Buka ulang → initDb menjalankan migrasi v2
    const fresh = initDb(tmp);
    expect(fresh.pragma('user_version', { simple: true })).toBe(2);
    expect(getSession(fresh)?.phone).toBe('+62');           // session selamat
    expect(listFiles(fresh)).toHaveLength(0);               // data channel lama dibersihkan
    const catNew = listCategories(fresh).find((c) => c.key === 'dokumen')!;
    expect(catNew.channelId).toBeNull();                    // referensi topik direset
    expect(catNew.state).toBe('pending_channel');
    expect(getSyncStats(fresh)).toEqual({ pending: 0, sent: 0 });
    fresh.close();
  });

  it('idempoten: user_version=2 tidak menjalankan reset lagi', () => {
    const tmp = `/tmp/td-mig2-${Date.now()}.sqlite`;
    const a = initDb(tmp);
    ensureCategories(a);
    upsertCategoryTopic(a, 'gambar', 55, 'Gambar');
    a.close(); // initDb kedua: user_version sudah 2
    const b = initDb(tmp);
    expect(b.pragma('user_version', { simple: true })).toBe(2);
    expect(listCategories(b).find((c) => c.key === 'gambar')!.channelId).toBe(55); // tak direset
    b.close();
  });
});

describe('insertFile', () => {
  const file = {
    fileUid: 'uid-1',
    name: 'laporan-2026.pdf',
    ext: 'pdf',
    mime: 'application/pdf',
    size: 1234,
    uploadedAt: '2026-06-15T10:00:00.000Z',
  };

  it('inserts a file and it becomes searchable by text', () => {
    ensureCategories(db);
    const cat = listCategories(db).find((c) => c.key === 'dokumen')!;
    const row = insertFile(db, { ...file, categoryId: cat.id, channelId: -1001, messageId: 42 });
    expect(row.id).toBeGreaterThan(0);
    const hits = searchFiles(db, { text: 'laporan', ext: null, category: null, dateFrom: null, dateTo: null, minSize: null });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe('laporan-2026.pdf');
  });

  it('is idempotent on fileUid (dup upload returns existing row)', () => {
    ensureCategories(db);
    const cat = listCategories(db).find((c) => c.key === 'dokumen')!;
    const a = insertFile(db, { ...file, categoryId: cat.id, channelId: -1001, messageId: 42 });
    const b = insertFile(db, { ...file, categoryId: cat.id, channelId: -1001, messageId: 43 });
    expect(b.id).toBe(a.id);
  });

  it('lists files with category name', () => {
    ensureCategories(db);
    const cat = listCategories(db).find((c) => c.key === 'gambar')!;
    insertFile(db, { ...file, fileUid: 'uid-2', ext: 'jpg', categoryId: cat.id, channelId: -1002, messageId: 1 });
    const rows = listFiles(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.categoryKey).toBe('gambar');
  });
});

describe('searchFiles with ParsedQuery filters', () => {
  beforeEach(() => {
    ensureCategories(db);
    const cats = Object.fromEntries(listCategories(db).map((c) => [c.key, c]));
    insertFile(db, { fileUid: 'f1', name: 'laporan juni.pdf', ext: 'pdf', mime: 'application/pdf', size: 1000, uploadedAt: '2026-06-15T10:00:00.000Z', categoryId: cats['dokumen']!.id, channelId: -1, messageId: 1 });
    insertFile(db, { fileUid: 'f2', name: 'foto liburan.jpg', ext: 'jpg', mime: 'image/jpeg', size: 5_000_000, uploadedAt: '2026-09-20T10:00:00.000Z', categoryId: cats['gambar']!.id, channelId: -2, messageId: 2 });
    insertFile(db, { fileUid: 'f3', name: 'video wedding.mp4', ext: 'mp4', mime: 'video/mp4', size: 200_000_000, uploadedAt: '2025-01-05T10:00:00.000Z', categoryId: cats['video']!.id, channelId: -3, messageId: 3 });
  });

  const empty = { text: '', ext: null, category: null, dateFrom: null, dateTo: null, minSize: null };

  it('filters by ext', () => {
    const hits = searchFiles(db, { ...empty, ext: 'pdf' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe('laporan juni.pdf');
  });

  it('filters by category key', () => {
    const hits = searchFiles(db, { ...empty, category: 'gambar' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.ext).toBe('jpg');
  });

  it('filters by date range', () => {
    const hits = searchFiles(db, { ...empty, dateFrom: '2026-06-01T00:00:00.000Z', dateTo: '2026-06-30T23:59:59.999Z' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe('laporan juni.pdf');
  });

  it('filters by minSize', () => {
    expect(searchFiles(db, { ...empty, minSize: 10_000_000 })).toHaveLength(1); // hanya video 200MB
    expect(searchFiles(db, { ...empty, minSize: 1_000_000 })).toHaveLength(2); // foto 5MB + video 200MB
  });

  it('combines text + ext filters', () => {
    const hits = searchFiles(db, { ...empty, text: 'laporan', ext: 'pdf' });
    expect(hits).toHaveLength(1);
    const none = searchFiles(db, { ...empty, text: 'laporan', ext: 'jpg' });
    expect(none).toHaveLength(0);
  });

  it('never throws on weird fts input', () => {
    expect(() => searchFiles(db, { ...empty, text: 'AND OR " <>' })).not.toThrow();
  });
});

describe('sync queue', () => {
  it('enqueues, dequeues once, and reports stats', () => {
    ensureCategories(db);
    const cat = listCategories(db).find((c) => c.key === 'dokumen')!;
    const f = insertFile(db, { fileUid: 's1', name: 'a.txt', ext: 'txt', mime: 'text/plain', size: 10, uploadedAt: '2026-10-11T10:00:00.000Z', categoryId: cat.id, channelId: -1, messageId: 9 });
    enqueueSync(db, f.id);
    enqueueSync(db, f.id); // dobel tidak dobel antre
    const batch = dequeueSyncBatch(db, 10);
    expect(batch).toHaveLength(1);
    expect(batch[0]!.fileUid).toBe('s1');
    markSynced(db, f.id);
    const stats = getSyncStats(db);
    expect(stats.pending).toBe(0);
    expect(stats.sent).toBe(1);
    expect(dequeueSyncBatch(db, 10)).toHaveLength(0);
  });
});
