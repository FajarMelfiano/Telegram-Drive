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
  /** Nama tampilan (hasil rename); null = pakai name asli. */
  displayName: string | null;
  /** Tag manual, JSON array string (mis. ["urgent","q3"]). */
  tags: string[];
  /** Asal file: telegram (upload/manual) | whatsapp (direct chat). */
  source: string;
  chatJid: string | null;
  waMsgId: string | null;
}

export interface InsertFileInput {
  fileUid: string; name: string; ext: string | null; mime: string | null;
  size: number; uploadedAt: string;
  categoryId: number; channelId: number | null; messageId: number | null;
  displayName?: string | null; tags?: string[];
  source?: string; chatJid?: string | null; waMsgId?: string | null;
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
  display_name TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'telegram',
  chat_jid TEXT,
  wa_msg_id TEXT,
  UNIQUE (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_files_category ON files(category_id);
CREATE INDEX IF NOT EXISTS idx_files_uploaded ON files(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_files_source ON files(source);

CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(name, display_name, tags, content='files', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name, display_name, tags) VALUES (new.id, new.name, new.display_name, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, display_name, tags) VALUES ('delete', old.id, old.name, old.display_name, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, display_name, tags) VALUES ('delete', old.id, old.name, old.display_name, old.tags);
  INSERT INTO files_fts(rowid, name, display_name, tags) VALUES (new.id, new.name, new.display_name, new.tags);
END;

CREATE TABLE IF NOT EXISTS sync_queue (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  queued_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS drive_group (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  group_id INTEGER NOT NULL,
  group_title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS album_files (
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (album_id, file_id)
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  device_id INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  device_label TEXT
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/**
 * Migrasi sekali-jalan (PRAGMA user_version).
 * v2 → era grup forum: channel-per-kategori diganti 1 grup + topik/kategori.
 * v3 → drive-fitur: kolom files bertambah (display_name, tags, source, chat_jid,
 *      wa_msg_id) + tabel albums/activity/devices/refresh_tokens/pairing_codes/kv.
 *      **tg_sessions TIDAK disentuh** → user tidak perlu login ulang.
 */
function migrate(db: Db): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version >= 3) return;
  const tx = db.transaction(() => {
    // Lepas trigger FTS lama lebih dulu: wipe (DELETE) tidak boleh menyentuh
    // index lama yang akan dibuang — kalau tidak, perintah 'delete' dengan nilai
    // NULL bisa membuat index korup ("disk image is malformed").
    db.exec(`DROP TRIGGER IF EXISTS files_ai; DROP TRIGGER IF EXISTS files_ad; DROP TRIGGER IF EXISTS files_au;`);
    if (version < 2) {
      db.exec('DELETE FROM sync_queue; DELETE FROM files;');
      db.exec(`UPDATE categories SET channel_id = NULL, channel_title = NULL, state = 'pending_channel';`);
    }
    if (version < 3) {
      const cols = db.prepare(`PRAGMA table_info(files)`).all() as Array<{ name: string }>;
      const have = new Set(cols.map((c) => c.name));
      const add = (ddl: string, name: string) => { if (!have.has(name)) db.exec(ddl); };
      add(`ALTER TABLE files ADD COLUMN display_name TEXT`, 'display_name');
      add(`ALTER TABLE files ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'`, 'tags');
      add(`ALTER TABLE files ADD COLUMN source TEXT NOT NULL DEFAULT 'telegram'`, 'source');
      add(`ALTER TABLE files ADD COLUMN chat_jid TEXT`, 'chat_jid');
      add(`ALTER TABLE files ADD COLUMN wa_msg_id TEXT`, 'wa_msg_id');
      // Bangun ulang FTS dengan kolom baru (name, display_name, tags).
      db.exec(`DROP TABLE IF EXISTS files_fts;
               CREATE VIRTUAL TABLE files_fts USING fts5(name, display_name, tags, content='files', content_rowid='id');
               INSERT INTO files_fts(files_fts) VALUES('rebuild');`);
      // Pasang kembali trigger (versi 3 kolom) supaya insert/update/delete mengindex FTS.
      db.exec(`
        CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
          INSERT INTO files_fts(rowid, name, display_name, tags) VALUES (new.id, new.name, new.display_name, new.tags);
        END;
        CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
          INSERT INTO files_fts(files_fts, rowid, name, display_name, tags) VALUES ('delete', old.id, old.name, old.display_name, old.tags);
        END;
        CREATE TRIGGER files_au AFTER UPDATE ON files BEGIN
          INSERT INTO files_fts(files_fts, rowid, name, display_name, tags) VALUES ('delete', old.id, old.name, old.display_name, old.tags);
          INSERT INTO files_fts(rowid, name, display_name, tags) VALUES (new.id, new.name, new.display_name, new.tags);
        END;`);
      // DB lama punya sync_queue tanpa ON DELETE CASCADE → file tak bisa dihapus
      // (FOREIGN KEY constraint failed). Bangun ulang tabelnya dengan cascade + bersihkan orphan.
      db.exec(`
        DELETE FROM sync_queue WHERE file_id NOT IN (SELECT id FROM files);
        CREATE TABLE IF NOT EXISTS sync_queue_new (
          file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
          queued_at TEXT NOT NULL,
          sent_at TEXT
        );
        INSERT INTO sync_queue_new (file_id, queued_at, sent_at)
          SELECT file_id, queued_at, sent_at FROM sync_queue;
        DROP TABLE sync_queue;
        ALTER TABLE sync_queue_new RENAME TO sync_queue;`);
    }
    db.pragma('user_version = 3');
  });
  tx();
}

export function initDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
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

export function upsertCategoryTopic(db: Db, key: string, topicId: number, topicTitle: string): void {
  db.prepare(`
    UPDATE categories SET channel_id = ?, channel_title = ?, state = 'ready' WHERE key = ?
  `).run(topicId, topicTitle, key);
}

// ---- grup forum tunggal (singleton) ----

export interface DriveGroupRow { groupId: number; groupTitle: string }

export function getDriveGroup(db: Db): DriveGroupRow | undefined {
  const row = db.prepare('SELECT group_id, group_title FROM drive_group WHERE id = 1').get() as
    | { group_id: number; group_title: string } | undefined;
  return row ? { groupId: row.group_id, groupTitle: row.group_title } : undefined;
}

export function saveDriveGroup(db: Db, input: DriveGroupRow): void {
  db.prepare(`
    INSERT INTO drive_group (id, group_id, group_title, created_at) VALUES (1, @groupId, @groupTitle, @createdAt)
    ON CONFLICT(id) DO UPDATE SET group_id = @groupId, group_title = @groupTitle
  `).run({ ...input, createdAt: new Date().toISOString() });
}

/** Lepas cache grup (mis. grup dihapus user) → upload berikut membuat ulang. */
export function clearDriveGroup(db: Db): void {
  db.prepare('DELETE FROM drive_group WHERE id = 1').run();
}

/** Reset referensi topik semua kategori (grup/topik sudah tak ada di Telegram). */
export function resetCategoryTopics(db: Db): void {
  db.prepare(`UPDATE categories SET channel_id = NULL, channel_title = NULL, state = 'pending_channel'`).run();
}

/** Insert file; idempoten — duplikat file_uid (atau channel+message) mengembalikan baris lama. */
export function insertFile(db: Db, input: InsertFileInput): FileRow {
  const existing = db.prepare('SELECT * FROM files WHERE file_uid = ?').get(input.fileUid) as
    | (Omit<FileRow, 'categoryKey'> & { category_id: number })
    | undefined;
  if (existing) return withCategoryKey(db, existing);

  try {
    const res = db.prepare(`
      INSERT INTO files (file_uid, name, ext, mime, size, category_id, channel_id, message_id, uploaded_at, state,
                         display_name, tags, source, chat_jid, wa_msg_id)
      VALUES (@fileUid, @name, @ext, @mime, @size, @categoryId, @channelId, @messageId, @uploadedAt, 'indexed',
              @displayName, @tags, @source, @chatJid, @waMsgId)
    `).run({
      ...input,
      displayName: input.displayName ?? null,
      tags: JSON.stringify(input.tags ?? []),
      source: input.source ?? 'telegram',
      chatJid: input.chatJid ?? null,
      waMsgId: input.waMsgId ?? null,
    });
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
  display_name: string | null; tags: string | null;
  source: string; chat_jid: string | null; wa_msg_id: string | null;
}

/** better-sqlite3 mengembalikan snake_case → samakan dengan tipe camelCase. */
function mapFileRow(r: RawFileRow): FileRow {
  let tags: string[] = [];
  try { tags = JSON.parse(r.tags ?? '[]') as string[]; } catch { tags = []; }
  return {
    id: r.id, fileUid: r.file_uid, name: r.name, ext: r.ext, mime: r.mime, size: r.size,
    categoryId: r.category_id, categoryKey: r.categoryKey,
    channelId: r.channel_id, messageId: r.message_id,
    uploadedAt: r.uploaded_at, state: r.state,
    displayName: r.display_name, tags,
    source: r.source ?? 'telegram', chatJid: r.chat_jid, waMsgId: r.wa_msg_id,
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

// ---- activity log ----

export interface ActivityRow { id: number; type: string; detail: unknown; createdAt: string }

export function logActivity(db: Db, type: string, detail?: unknown): void {
  db.prepare('INSERT INTO activity (type, detail, created_at) VALUES (?, ?, ?)')
    .run(type, detail != null ? JSON.stringify(detail) : null, new Date().toISOString());
}

export function listActivity(db: Db, limit = 50): ActivityRow[] {
  const rows = db.prepare('SELECT id, type, detail, created_at FROM activity ORDER BY id DESC LIMIT ?')
    .all(limit) as Array<{ id: number; type: string; detail: string | null; created_at: string }>;
  return rows.map((r) => {
    let detail: unknown = null;
    try { detail = r.detail ? JSON.parse(r.detail) : null; } catch { detail = null; }
    return { id: r.id, type: r.type, detail, createdAt: r.created_at };
  });
}

// ---- devices & refresh token ----

export interface DeviceRow { id: number; label: string; userAgent: string | null; createdAt: string; lastSeenAt: string }

export function upsertDevice(db: Db, label: string, userAgent: string | null): DeviceRow {
  const existing = db.prepare('SELECT * FROM devices WHERE label = ? AND COALESCE(user_agent, \'\') = COALESCE(?, \'\')')
    .get(label, userAgent) as { id: number; label: string; user_agent: string | null; created_at: string; last_seen_at: string } | undefined;
  const now = new Date().toISOString();
  if (existing) {
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
    return { id: existing.id, label: existing.label, userAgent: existing.user_agent, createdAt: existing.created_at, lastSeenAt: now };
  }
  const res = db.prepare('INSERT INTO devices (label, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?)')
    .run(label, userAgent, now, now);
  return { id: Number(res.lastInsertRowid), label, userAgent, createdAt: now, lastSeenAt: now };
}

export function listDevices(db: Db): DeviceRow[] {
  const rows = db.prepare('SELECT * FROM devices ORDER BY last_seen_at DESC').all() as
    Array<{ id: number; label: string; user_agent: string | null; created_at: string; last_seen_at: string }>;
  return rows.map((r) => ({ id: r.id, label: r.label, userAgent: r.user_agent, createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
}

export function getDevice(db: Db, id: number): DeviceRow | undefined {
  return listDevices(db).find((d) => d.id === id);
}

export function deleteDevice(db: Db, id: number): void {
  db.prepare('DELETE FROM refresh_tokens WHERE device_id = ?').run(id);
  db.prepare('DELETE FROM devices WHERE id = ?').run(id);
}

/** Simpan refresh token (hanya hash-nya). Rotasi: token lama dicabut saat refresh. */
export function saveRefreshToken(db: Db, tokenHash: string, deviceId: number, expiresAt: string): void {
  db.prepare('INSERT INTO refresh_tokens (token_hash, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(tokenHash, deviceId, new Date().toISOString(), expiresAt);
}

export function findRefreshToken(db: Db, tokenHash: string): { id: number; deviceId: number | null; expiresAt: string; revokedAt: string | null } | undefined {
  const r = db.prepare('SELECT id, device_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?')
    .get(tokenHash) as { id: number; device_id: number | null; expires_at: string; revoked_at: string | null } | undefined;
  return r ? { id: r.id, deviceId: r.device_id, expiresAt: r.expires_at, revokedAt: r.revoked_at } : undefined;
}

export function revokeRefreshToken(db: Db, tokenHash: string): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), tokenHash);
}

export function revokeAllTokensForDevice(db: Db, deviceId: number): void {
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), deviceId);
}

// ---- pairing code (login web via QR dari HP) ----

export interface PairingRow { code: string; expiresAt: string; claimedAt: string | null; deviceLabel: string | null }

export function savePairingCode(db: Db, code: string, expiresAt: string, deviceLabel: string | null): void {
  db.prepare('INSERT OR REPLACE INTO pairing_codes (code, created_at, expires_at, claimed_at, device_label) VALUES (?, ?, ?, NULL, ?)')
    .run(code, new Date().toISOString(), expiresAt, deviceLabel);
}

export function getPairingCode(db: Db, code: string): PairingRow | undefined {
  const r = db.prepare('SELECT code, expires_at, claimed_at, device_label FROM pairing_codes WHERE code = ?')
    .get(code) as { code: string; expires_at: string; claimed_at: string | null; device_label: string | null } | undefined;
  return r ? { code: r.code, expiresAt: r.expires_at, claimedAt: r.claimed_at, deviceLabel: r.device_label } : undefined;
}

/** Klaim atomik: hanya berhasil sekali (single-use). */
export function claimPairingCode(db: Db, code: string): boolean {
  const res = db.prepare('UPDATE pairing_codes SET claimed_at = ? WHERE code = ? AND claimed_at IS NULL')
    .run(new Date().toISOString(), code);
  return res.changes > 0;
}

export function cleanupExpiredPairing(db: Db): void {
  db.prepare('DELETE FROM pairing_codes WHERE expires_at < ?').run(new Date().toISOString());
}

// ---- kv store (nilai terenkripsi, mis. auth state WhatsApp) ----

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt')
    .run(key, value, new Date().toISOString());
}

export function kvGet(db: Db, key: string): string | undefined {
  const r = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value;
}

export function kvDelete(db: Db, key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}

// ---- update & hapus file (fitur drive) ----

/** Perbarui nama tampilan dan/atau tag file. Partial: field yang tidak diberikan tak disentuh. */
export function updateFile(db: Db, id: number, patch: { displayName?: string | null; tags?: string[] }): FileRow | undefined {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  if (patch.displayName !== undefined) { sets.push('display_name = @displayName'); params.displayName = patch.displayName; }
  if (patch.tags !== undefined) { sets.push('tags = @tags'); params.tags = JSON.stringify(patch.tags); }
  if (sets.length === 0) return getFileById(db, id);
  db.prepare(`UPDATE files SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getFileById(db, id);
}

/**
 * Pindahkan file ke kategori lain (by key). `newLoc` = lokasi salinan yang baru
 * dikirim (channel+pesan topik tujuan) — WAJIB diisi setelah kirim sukses supaya
 * DB tidak lagi menunjuk pesan lama yang sudah dihapus.
 */
export function moveFileCategory(
  db: Db, id: number, categoryKey: string,
  newLoc?: { channelId: number; messageId: number },
): FileRow | undefined {
  const cat = getCategoryByKey(db, categoryKey);
  if (!cat) return undefined;
  db.prepare('UPDATE files SET category_id = ?, channel_id = ?, message_id = ? WHERE id = ?')
    .run(cat.id, newLoc?.channelId ?? null, newLoc?.messageId ?? null, id);
  return getFileById(db, id);
}

/** Hapus baris file (FTS + album_files ikut via trigger/ON DELETE CASCADE). */
export function deleteFile(db: Db, id: number): boolean {
  const res = db.prepare('DELETE FROM files WHERE id = ?').run(id);
  return res.changes > 0;
}

// ---- album ----

export interface AlbumRow { id: number; name: string; createdAt: string; fileCount: number }

export function listAlbums(db: Db): AlbumRow[] {
  return db.prepare(`
    SELECT a.id, a.name, a.created_at AS createdAt, COUNT(af.file_id) AS fileCount
    FROM albums a LEFT JOIN album_files af ON af.album_id = a.id
    GROUP BY a.id ORDER BY a.created_at DESC
  `).all() as AlbumRow[];
}

export function createAlbum(db: Db, name: string): AlbumRow {
  const res = db.prepare('INSERT INTO albums (name, created_at) VALUES (?, ?)').run(name, new Date().toISOString());
  return { id: Number(res.lastInsertRowid), name, createdAt: new Date().toISOString(), fileCount: 0 };
}

export function getAlbum(db: Db, id: number): AlbumRow | undefined {
  return listAlbums(db).find((a) => a.id === id);
}

export function renameAlbum(db: Db, id: number, name: string): void {
  db.prepare('UPDATE albums SET name = ? WHERE id = ?').run(name, id);
}

export function deleteAlbum(db: Db, id: number): boolean {
  return db.prepare('DELETE FROM albums WHERE id = ?').run(id).changes > 0;
}

export function addToAlbum(db: Db, albumId: number, fileIds: number[]): number {
  const maxPos = (db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM album_files WHERE album_id = ?').get(albumId) as { m: number }).m;
  const insert = db.prepare('INSERT OR IGNORE INTO album_files (album_id, file_id, position) VALUES (?, ?, ?)');
  let added = 0;
  let pos = maxPos + 1;
  for (const fid of fileIds) {
    const r = insert.run(albumId, fid, pos);
    if (r.changes > 0) { added++; pos++; }
  }
  return added;
}

export function removeFromAlbum(db: Db, albumId: number, fileId: number): boolean {
  return db.prepare('DELETE FROM album_files WHERE album_id = ? AND file_id = ?').run(albumId, fileId).changes > 0;
}

export function listAlbumFiles(db: Db, albumId: number): FileRow[] {
  return (db.prepare(`
    SELECT f.*, c.key AS categoryKey FROM album_files af
    JOIN files f ON f.id = af.file_id JOIN categories c ON c.id = f.category_id
    WHERE af.album_id = ? ORDER BY af.position
  `).all(albumId) as RawFileRow[]).map(mapFileRow);
}

// ---- statistik ----

export interface StatsResult {
  totalFiles: number;
  totalBytes: number;
  byCategory: Array<{ key: string; label: string; count: number; bytes: number }>;
  byExt: Array<{ ext: string; count: number; bytes: number }>;
  bySource: Array<{ source: string; count: number }>;
}

export function getStats(db: Db): StatsResult {
  const totals = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM files').get() as { n: number; b: number };
  const byCategory = db.prepare(`
    SELECT c.key, c.label, COUNT(f.id) AS count, COALESCE(SUM(f.size), 0) AS bytes
    FROM categories c LEFT JOIN files f ON f.category_id = c.id
    GROUP BY c.id HAVING count > 0 ORDER BY bytes DESC
  `).all() as StatsResult['byCategory'];
  const byExt = db.prepare(`
    SELECT COALESCE(ext, 'lainnya') AS ext, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes
    FROM files GROUP BY COALESCE(ext, 'lainnya') ORDER BY bytes DESC LIMIT 20
  `).all() as StatsResult['byExt'];
  const bySource = db.prepare('SELECT source, COUNT(*) AS count FROM files GROUP BY source').all() as StatsResult['bySource'];
  return { totalFiles: totals.n, totalBytes: totals.b, byCategory, byExt, bySource };
}
