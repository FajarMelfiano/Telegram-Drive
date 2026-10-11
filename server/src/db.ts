import Database from 'better-sqlite3';
import type { Database as Db } from 'better-sqlite3';
import { CATEGORY_LABELS, type FileCategory, type FileState, type ParsedQuery } from '@td/shared';

export interface CategoryRow {
  id: number; key: string; label: string;
  channelId: number | null; channelTitle: string | null;
  state: string; fileCount: number;
}

export interface FileRow {
  id: number; fileUid: string; name: string; ext: string | null; mime: string | null;
  size: number; categoryId: number; categoryKey: string;
  channelId: number | null; messageId: number | null;
  uploadedAt: string; state: FileState;
}

export interface InsertFileInput {
  fileUid: string; name: string; ext: string | null; mime: string | null;
  size: number; uploadedAt: string;
  categoryId: number; channelId: number | null; messageId: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tg_sessions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  api_id INTEGER NOT NULL,
  api_hash_enc TEXT NOT NULL,
  session_enc TEXT,
  phone TEXT NOT NULL,
  tg_user_id INTEGER,
  tg_name TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_flows (
  request_id TEXT PRIMARY KEY,
  api_id INTEGER NOT NULL,
  api_hash_enc TEXT NOT NULL,
  phone TEXT NOT NULL,
  phone_code_hash TEXT,
  state TEXT NOT NULL DEFAULT 'code_sent',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  channel_id INTEGER,
  channel_title TEXT,
  state TEXT NOT NULL DEFAULT 'pending_channel'
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_uid TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ext TEXT,
  mime TEXT,
  size INTEGER NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  channel_id INTEGER,
  message_id INTEGER,
  uploaded_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'indexed',
  UNIQUE (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_files_category ON files(category_id);
CREATE INDEX IF NOT EXISTS idx_files_uploaded ON files(uploaded_at);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, content='files', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name) VALUES (new.id, new.name);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name) VALUES ('delete', old.id, old.name);
END;

CREATE TABLE IF NOT EXISTS sync_queue (
  file_id INTEGER PRIMARY KEY REFERENCES files(id),
  queued_at TEXT NOT NULL,
  sent_at TEXT
);
`;

export function initDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Seed kategori default (sekali, idempoten). */
export function ensureCategories(db: Db): void {
  const insert = db.prepare('INSERT OR IGNORE INTO categories (key, label) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const key of Object.keys(CATEGORY_LABELS) as FileCategory[]) {
      insert.run(key, CATEGORY_LABELS[key]);
    }
  });
  tx();
}

export function listCategories(db: Db): CategoryRow[] {
  return db.prepare(`
    SELECT c.id, c.key, c.label, c.channel_id AS channelId, c.channel_title AS channelTitle,
           c.state, COUNT(f.id) AS fileCount
    FROM categories c LEFT JOIN files f ON f.category_id = c.id
    GROUP BY c.id ORDER BY c.id
  `).all() as CategoryRow[];
}

export interface CategoryRaw {
  id: number; key: string; label: string;
  channel_id: number | null; channel_title: string | null; state: string;
}

export function getCategoryByKey(db: Db, key: string): CategoryRaw | undefined {
  return db.prepare('SELECT * FROM categories WHERE key = ?').get(key) as CategoryRaw | undefined;
}

export function upsertCategoryChannel(db: Db, key: string, channelId: number, channelTitle: string): void {
  db.prepare(`
    UPDATE categories SET channel_id = ?, channel_title = ?, state = 'ready' WHERE key = ?
  `).run(channelId, channelTitle, key);
}

/** Insert file; idempoten — duplikat file_uid (atau channel+message) mengembalikan baris lama. */
export function insertFile(db: Db, input: InsertFileInput): FileRow {
  const existing = db.prepare('SELECT * FROM files WHERE file_uid = ?').get(input.fileUid) as
    | (Omit<FileRow, 'categoryKey'> & { category_id: number })
    | undefined;
  if (existing) return withCategoryKey(db, existing);

  try {
    const res = db.prepare(`
      INSERT INTO files (file_uid, name, ext, mime, size, category_id, channel_id, message_id, uploaded_at, state)
      VALUES (@fileUid, @name, @ext, @mime, @size, @categoryId, @channelId, @messageId, @uploadedAt, 'indexed')
    `).run(input);
    return getFileById(db, Number(res.lastInsertRowid))!;
  } catch (err) {
    // Race: channel+message sudah tercatat baris lain
    if (String(err).includes('UNIQUE')) {
      const byMsg = db.prepare('SELECT * FROM files WHERE channel_id = ? AND message_id = ?')
        .get(input.channelId, input.messageId) as (Omit<FileRow, 'categoryKey'> & { category_id: number }) | undefined;
      if (byMsg) return withCategoryKey(db, byMsg);
    }
    throw err;
  }
}

interface RawFileRow {
  id: number; file_uid: string; name: string; ext: string | null; mime: string | null;
  size: number; category_id: number; categoryKey: string;
  channel_id: number | null; message_id: number | null;
  uploaded_at: string; state: FileState;
}

/** better-sqlite3 mengembalikan snake_case → samakan dengan tipe camelCase. */
function mapFileRow(r: RawFileRow): FileRow {
  return {
    id: r.id, fileUid: r.file_uid, name: r.name, ext: r.ext, mime: r.mime, size: r.size,
    categoryId: r.category_id, categoryKey: r.categoryKey,
    channelId: r.channel_id, messageId: r.message_id,
    uploadedAt: r.uploaded_at, state: r.state,
  };
}

export function getFileById(db: Db, id: number): FileRow | undefined {
  const row = db.prepare(`
    SELECT f.*, c.key AS categoryKey FROM files f JOIN categories c ON c.id = f.category_id WHERE f.id = ?
  `).get(id) as RawFileRow | undefined;
  return row ? mapFileRow(row) : undefined;
}

function withCategoryKey(db: Db, row: Omit<FileRow, 'categoryKey'> & { category_id: number; categoryId?: number }): FileRow {
  const cat = db.prepare('SELECT key FROM categories WHERE id = ?').get(row.category_id) as { key: string } | undefined;
  return { ...row, categoryId: row.category_id, categoryKey: cat?.key ?? 'lainnya' } as FileRow;
}

const EMPTY_QUERY: ParsedQuery = { text: '', ext: null, category: null, dateFrom: null, dateTo: null, minSize: null };

/** Cari file: FTS5 untuk teks + filter struktural dari hasil parser. */
export function searchFiles(db: Db, q: ParsedQuery, limit = 50): FileRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };

  if (q.ext) { where.push('f.ext = @ext'); params.ext = q.ext; }
  if (q.category) { where.push('c.key = @category'); params.category = q.category; }
  if (q.dateFrom) { where.push('f.uploaded_at >= @dateFrom'); params.dateFrom = q.dateFrom; }
  if (q.dateTo) { where.push('f.uploaded_at <= @dateTo'); params.dateTo = q.dateTo; }
  if (q.minSize != null) { where.push('f.size >= @minSize'); params.minSize = q.minSize; }
  const text = (q.text ?? '').trim();
  if (text) {
    const match = text.split(/\s+/).map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND ');
    where.push("f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH @match)");
    params.match = match;
  }

  const sql = `
    SELECT f.*, c.key AS categoryKey FROM files f JOIN categories c ON c.id = f.category_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY f.uploaded_at DESC LIMIT @limit
  `;
  return (db.prepare(sql).all(params) as RawFileRow[]).map(mapFileRow);
}

export function listFiles(db: Db, opts: { categoryId?: number; limit?: number; offset?: number } = {}): FileRow[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  if (opts.categoryId != null) {
    return (db.prepare(`
      SELECT f.*, c.key AS categoryKey FROM files f JOIN categories c ON c.id = f.category_id
      WHERE f.category_id = ? ORDER BY f.uploaded_at DESC LIMIT ? OFFSET ?
    `).all(opts.categoryId, limit, offset) as RawFileRow[]).map(mapFileRow);
  }
  return (db.prepare(`
    SELECT f.*, c.key AS categoryKey FROM files f JOIN categories c ON c.id = f.category_id
    ORDER BY f.uploaded_at DESC LIMIT ? OFFSET ?
  `).all(limit, offset) as RawFileRow[]).map(mapFileRow);
}

export interface SessionRow {
  id: number; api_id: number; api_hash_enc: string; session_enc: string | null;
  phone: string; tg_user_id: number | null; tg_name: string | null; created_at: string;
}

export function saveSession(db: Db, input: {
  apiId: number; apiHashEnc: string; sessionEnc: string | null; phone: string;
  tgUserId?: number | null; tgName?: string | null;
}): void {
  db.prepare(`
    INSERT INTO tg_sessions (id, api_id, api_hash_enc, session_enc, phone, tg_user_id, tg_name, created_at)
    VALUES (1, @apiId, @apiHashEnc, @sessionEnc, @phone, @tgUserId, @tgName, @createdAt)
    ON CONFLICT(id) DO UPDATE SET
      api_id = @apiId, api_hash_enc = @apiHashEnc, session_enc = @sessionEnc,
      phone = @phone, tg_user_id = @tgUserId, tg_name = @tgName
  `).run({
    apiId: input.apiId, apiHashEnc: input.apiHashEnc, sessionEnc: input.sessionEnc,
    phone: input.phone, tgUserId: input.tgUserId ?? null, tgName: input.tgName ?? null,
    createdAt: new Date().toISOString(),
  });
}

export function getSession(db: Db): SessionRow | undefined {
  return db.prepare('SELECT * FROM tg_sessions WHERE id = 1').get() as SessionRow | undefined;
}

export function deleteSession(db: Db): void {
  db.prepare('DELETE FROM tg_sessions WHERE id = 1').run();
}

export function enqueueSync(db: Db, fileId: number): void {
  db.prepare('INSERT OR IGNORE INTO sync_queue (file_id, queued_at) VALUES (?, ?)').run(fileId, new Date().toISOString());
}

export function dequeueSyncBatch(db: Db, limit: number): FileRow[] {
  return (db.prepare(`
    SELECT f.*, c.key AS categoryKey FROM sync_queue s
    JOIN files f ON f.id = s.file_id JOIN categories c ON c.id = f.category_id
    WHERE s.sent_at IS NULL ORDER BY s.queued_at LIMIT ?
  `).all(limit) as RawFileRow[]).map(mapFileRow);
}

export function markSynced(db: Db, fileId: number): void {
  db.prepare('UPDATE sync_queue SET sent_at = ? WHERE file_id = ?').run(new Date().toISOString(), fileId);
}

export function getSyncStats(db: Db): { pending: number; sent: number } {
  const row = db.prepare(`
    SELECT SUM(CASE WHEN sent_at IS NULL THEN 1 ELSE 0 END) AS pending,
           SUM(CASE WHEN sent_at IS NOT NULL THEN 1 ELSE 0 END) AS sent
    FROM sync_queue
  `).get() as { pending: number | null; sent: number | null };
  return { pending: row.pending ?? 0, sent: row.sent ?? 0 };
}
