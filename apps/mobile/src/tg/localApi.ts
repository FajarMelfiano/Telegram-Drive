// Port lokal dari server/src/app.ts — meniru rute HTTP Fastify di belakang
// kontrak `Api` (src/api.ts) tanpa jaringan. DB lokal (expo-sqlite) + gateway
// teleproto. JWT/pairing/devices/refresh/SSE/WA/xlsx-dari-ExcelJS dikarantina
// (tidak dipakai app mandiri) dan dijawab dengan kode yang ramah UI.
//
// Alur berkas meniru server: unduh/salin dari Telegram → tulis ke cache (file
// temp) → kirim/preview/baca → hapus. Karena tidak ada stream, berkas di-handle
// sebagai berkas biasa lewat expo-file-system legacy.
import { randomUUID } from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { parseQuery, classifyFile, CATEGORY_LABELS, type FileCategory } from '@td/shared';
import {
  initDb, ensureCategories, listCategories, getCategoryByKey, upsertCategoryTopic,
  insertFile, searchFiles, listFiles, getSyncStats, getFileById, getStats, listActivity,
  updateFile, deleteFile, moveFileCategory, logActivity,
  getDriveGroup, saveDriveGroup, clearDriveGroup, resetCategoryTopics,
  listAlbums, createAlbum, renameAlbum, deleteAlbum, addToAlbum, removeFromAlbum, listAlbumFiles,
} from './db';
import type { Db } from './sqlite';
import { createRealGateway, mapTelegramError, type TelegramGateway } from './telegram';

const DRIVE_GROUP_TITLE = 'Telegram Drive';
const DRIVE_GROUP_ABOUT = 'Drive pribadi yang disimpan di Telegram';

export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterSeconds?: number) {
    super(code);
  }
}

interface MeInfoOut { id: number; firstName: string; username?: string }
type PendingAuth = { gateway: TelegramGateway; apiId: number; apiHash: string; phone: string; phoneCodeHash: string };

let db: Db | null = null;
let gateway: TelegramGateway | null = null;
let pendingAuth: PendingAuth | null = null;
let ensureDbPromise: Promise<Db> | null = null;

function cacheDir(): string {
  return FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? '';
}
function documentDir(): string {
  return FileSystem.documentDirectory ?? '';
}
let cacheDirEnsured = false;
async function ensureCacheDir(): Promise<string> {
  const dir = cacheDir();
  if (!cacheDirEnsured && dir) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
    cacheDirEnsured = true;
  }
  return dir;
}

async function tempFile(prefix: string): Promise<string> {
  const dir = await ensureCacheDir();
  return `${dir}${prefix}-${randomUUID()}`;
}

/** Map file-id → URI `file://` cache untuk preview sinkron (<img>). */
const previewUriCache = new Map<number, string>();
/** Kunci idempoten unggah → id file (meniru getFileByClientUploadId server). */
const uploadIdDedupe = new Map<string, number>();

async function database(): Promise<Db> {
  if (db) return db;
  if (!ensureDbPromise) {
    ensureDbPromise = (async () => {
      const handle = initDb(`${documentDir()}telegram-drive.sqlite`);
      ensureCategories(handle);
      return handle;
    })();
  }
  db = await ensureDbPromise;
  return db;
}

/** Hidupkan gateway dari kredensial sesi (dipanggil auth setelah login tersimpan). */
export async function loadSession(apiId: number, apiHash: string, session: string): Promise<void> {
  await database();
  gateway = await createRealGateway(apiId, apiHash, session);
}

export function unloadSession(): void {
  gateway?.destroy();
  gateway = null;
}

export function isLoggedIn(): boolean {
  return gateway != null;
}

function mapTelegramToApi(err: unknown): never {
  const mapped = mapTelegramError(err);
  const status = mapped.code === 'FLOOD_WAIT' ? 429
    : mapped.code === 'PHONE_CODE_INVALID' || mapped.code === 'PASSWORD_INVALID' ? 401 : 400;
  throw new ApiError(status, mapped.code, mapped.retryAfterSeconds);
}

const isPeerGone = (err: unknown): boolean =>
  /PEER_ID_INVALID|CHANNEL_PRIVATE|CHANNEL_INVALID|CHAT_ADMIN_REQUIRED/i.test(
    String(err instanceof Error ? err.message : err),
  );

type SentDest = { groupId: number; topicId: number; messageId: number };

async function sendToCategory(
  g: TelegramGateway, d: Db, category: string, label: string, data: Buffer, name: string,
): Promise<SentDest> {
  const attempt = async (): Promise<SentDest> => {
    let group = getDriveGroup(d);
    if (!group) {
      const created = await g.ensureDriveGroup(DRIVE_GROUP_TITLE, DRIVE_GROUP_ABOUT);
      group = { groupId: created.groupId, groupTitle: created.title };
      saveDriveGroup(d, group);
    }
    const groupId = group.groupId;
    const cat = getCategoryByKey(d, category)!;
    let topicId = cat.channel_id;
    if (topicId == null) {
      const topic = await g.ensureTopic(groupId, label);
      upsertCategoryTopic(d, category, topic.topicId, topic.title);
      topicId = topic.topicId;
    }
    const sent = await g.sendFileToTopic(groupId, topicId, data, name);
    return { groupId, topicId, messageId: sent.messageId };
  };
  try {
    return await attempt();
  } catch (err) {
    if (!isPeerGone(err)) throw err;
    clearDriveGroup(d);
    resetCategoryTopics(d);
    return attempt();
  }
}

// getDriveGroup / saveDriveGroup / clearDriveGroup / resetCategoryTopics diimpor
// dari db bersama import lain di atas.

function recordActivity(d: Db, type: string, detail?: unknown): void {
  logActivity(d, type, detail);
}

async function cleanup(...paths: string[]): Promise<void> {
  for (const p of paths) {
    if (p) await FileSystem.deleteAsync(p, { idempotent: true }).catch(() => undefined);
  }
}

interface UploadedFile { uri: string; name?: string; type?: string }

function extractUploadedFile(form?: FormData): UploadedFile | null {
  if (!form) return null;
  const parts = (form as unknown as { _parts?: [string, unknown][] })._parts;
  if (Array.isArray(parts)) {
    for (const [, v] of parts) {
      if (v && typeof v === 'object' && 'uri' in (v as object)) return v as UploadedFile;
    }
  }
  return null;
}

const notLoggedIn = (): never => {
  throw new ApiError(401, 'NOT_LOGGED_IN');
};
const needGateway = (): TelegramGateway => gateway ?? notLoggedIn();

/** Meja dispatch: (method, path) → handler, meniru rute app.ts yang dipakai Api. */
export async function localApi<T>(
  method: string,
  path: string,
  opts: { body?: unknown; formData?: FormData } = {},
): Promise<T> {
  const d = await database();
  const [rawPath, rawQuery] = path.split('?');
  const query = new URLSearchParams(rawQuery ?? '');
  const seg = rawPath!.split('/').filter(Boolean);
  const M = method.toUpperCase();

  // ---- AUTH ----
  if (seg[0] === 'auth' && seg[1] === 'start' && M === 'POST') {
    const b = opts.body as { apiId: number; apiHash: string; phone: string };
    const g = await createRealGateway(b.apiId, b.apiHash);
    try {
      const { phoneCodeHash } = await g.sendCode(b.phone);
      pendingAuth = { gateway: g, apiId: b.apiId, apiHash: b.apiHash, phone: b.phone, phoneCodeHash };
      return { requestId: randomUUID() } as T;
    } catch (err) {
      g.destroy();
      mapTelegramToApi(err);
    }
  }
  if (seg[0] === 'auth' && seg[1] === 'verify' && M === 'POST') {
    const b = opts.body as { code: string };
    const p = pendingAuth;
    if (!p) throw new ApiError(401, 'AUTH_FLOW_EXPIRED');
    try {
      const { twoFa } = await p.gateway.signIn(p.phone, p.phoneCodeHash, b.code);
      if (twoFa) return { status: 'need_password' } as T;
      const me = (await p.gateway.getMe()) as MeInfoOut;
      gateway = p.gateway;
      pendingAuth = null;
      // Sertakan session string agar app bisa menyimpannya di SecureStore
      // (persistensi login lintas-restart — lihat src/tg/session.ts).
      return {
        token: 'local', me,
        session: p.gateway.sessionString(), apiId: p.apiId, apiHash: p.apiHash,
      } as T;
    } catch (err) {
      mapTelegramToApi(err);
    }
  }
  if (seg[0] === 'auth' && seg[1] === 'password' && M === 'POST') {
    const b = opts.body as { password: string };
    const p = pendingAuth;
    if (!p) throw new ApiError(401, 'AUTH_FLOW_EXPIRED');
    try {
      await p.gateway.checkPassword(b.password);
      const me = (await p.gateway.getMe()) as MeInfoOut;
      gateway = p.gateway;
      pendingAuth = null;
      return {
        token: 'local', me,
        session: p.gateway.sessionString(), apiId: p.apiId, apiHash: p.apiHash,
      } as T;
    } catch (err) {
      mapTelegramToApi(err);
    }
  }
  if (seg[0] === 'auth' && seg[1] === 'logout' && M === 'POST') {
    unloadSession();
    return { ok: true } as T;
  }
  if (seg[0] === 'auth' && seg[1] === 'pairing') throw new ApiError(501, 'PAIRING_UNSUPPORTED');
  if (seg[0] === 'auth' && seg[1] === 'refresh') throw new ApiError(501, 'REFRESH_UNSUPPORTED');

  // ---- ME ----
  if (seg[0] === 'me' && M === 'GET') {
    const g = needGateway();
    const me = await g.getMe();
    return { me, phone: null } as T;
  }

  // ---- CATEGORIES / SYNC ----
  if (seg[0] === 'categories' && M === 'GET') return { categories: listCategories(d) } as T;
  if (seg[0] === 'sync' && seg[1] === 'status' && M === 'GET') return getSyncStats(d) as T;

  // ---- FILES ----
  if (seg[0] === 'files' && seg.length === 1 && M === 'GET') {
    const category = query.get('category') ?? undefined;
    const limit = Number(query.get('limit') ?? '50');
    const cat = category ? getCategoryByKey(d, category) : undefined;
    return { files: listFiles(d, { categoryId: cat?.id, limit }) } as T;
  }
  if (seg[0] === 'files' && seg.length === 1 && M === 'POST') {
    const g = needGateway();
    const clientUploadId = query.get('clientUploadId') ?? undefined;
    // Idempoten: unggah ulang dengan kunci sama → kembalikan file lama (tanpa dobel).
    if (clientUploadId && uploadIdDedupe.has(clientUploadId)) {
      const existing = getFileById(d, uploadIdDedupe.get(clientUploadId)!);
      if (existing) return { file: existing, deduped: true } as T;
    }
    const uploaded = extractUploadedFile(opts.formData);
    if (!uploaded) throw new ApiError(422, 'NO_FILE');
    const info = await FileSystem.getInfoAsync(uploaded.uri);
    const size = info.exists && 'size' in info ? info.size : 0;
    const { category } = classifyFile(uploaded.type ?? '', uploaded.name ?? '');
    const label = CATEGORY_LABELS[category as FileCategory];
    const cat = getCategoryByKey(d, category)!;
    const name = uploaded.name ?? 'file';
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
    const staging = await tempFile('up');
    try {
      await FileSystem.copyAsync({ from: uploaded.uri, to: staging });
      const buf = await FileSystem.readAsStringAsync(staging, { encoding: FileSystem.EncodingType.Base64 });
      const sent = await sendToCategory(g, d, category, label, Buffer.from(buf, 'base64'), name);
      const file = insertFile(d, {
        fileUid: randomUUID(), name, ext, mime: uploaded.type ?? null, size,
        uploadedAt: new Date().toISOString(), categoryId: cat.id,
        channelId: sent.groupId, messageId: sent.messageId,
        clientUploadId: clientUploadId ?? null,
      });
      if (clientUploadId) uploadIdDedupe.set(clientUploadId, file.id);
      recordActivity(d, 'file.uploaded', { id: file.id, name: file.name, categoryKey: file.categoryKey, size: file.size });
      return { file } as T;
    } catch (err) {
      mapTelegramToApi(err);
    } finally {
      await cleanup(staging);
    }
  }
  if (seg[0] === 'files' && seg[1] === 'batch' && M === 'POST') {
    const b = opts.body as { action: 'delete' | 'move' | 'tag'; ids: number[]; category?: string; tags?: string[] };
    const results: { id: number; ok: boolean; error?: string }[] = [];
    for (const id of [...new Set(b.ids)]) {
      const file = getFileById(d, id);
      if (!file) { results.push({ id, ok: false, error: 'FILE_NOT_FOUND' }); continue; }
      try {
        if (b.action === 'delete') {
          if (gateway && file.channelId != null && file.messageId != null) {
            await gateway.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
          }
          deleteFile(d, id);
          recordActivity(d, 'file.deleted', { id, name: file.name });
        } else if (b.action === 'move') {
          const cat = getCategoryByKey(d, b.category!)!;
          if (!gateway) { results.push({ id, ok: false, error: 'NOT_LOGGED_IN' }); continue; }
          if (file.channelId == null || file.messageId == null) { results.push({ id, ok: false, error: 'NOT_UPLOADED' }); continue; }
          if (cat.id === file.categoryId) { results.push({ id, ok: true }); continue; }
          const staging = await tempFile('bm');
          try {
            await gateway.downloadFile(file.channelId, file.messageId, staging);
            const data = Buffer.from(await FileSystem.readAsStringAsync(staging, { encoding: 'base64' }), 'base64');
            const sent = await sendToCategory(gateway, d, cat.key, cat.label, data, file.name);
            await gateway.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
            moveFileCategory(d, id, cat.key, { channelId: sent.groupId, messageId: sent.messageId });
            recordActivity(d, 'file.moved', { id, to: cat.key });
          } finally {
            await cleanup(staging);
          }
        } else if (b.action === 'tag') {
          updateFile(d, id, { tags: b.tags ?? [] });
          recordActivity(d, 'file.updated', { id, tags: b.tags });
        }
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : 'UNKNOWN' });
      }
    }
    return { results } as T;
  }
  if (seg[0] === 'files' && seg.length === 2 && M === 'PATCH') {
    const id = Number(seg[1]);
    const file = getFileById(d, id);
    if (!file) throw new ApiError(404, 'FILE_NOT_FOUND');
    const b = opts.body as { displayName?: string | null; tags?: string[] };
    const updated = updateFile(d, id, b)!;
    if (b.displayName !== undefined && file.channelId != null && file.messageId != null && gateway) {
      await gateway.editCaption(file.channelId, file.messageId, updated.displayName ?? updated.name).catch(() => undefined);
    }
    recordActivity(d, 'file.updated', { id, displayName: updated.displayName, tags: updated.tags });
    return { file: updated } as T;
  }
  if (seg[0] === 'files' && seg.length === 3 && seg[2] === 'category' && M === 'PATCH') {
    const id = Number(seg[1]);
    const file = getFileById(d, id);
    if (!file) throw new ApiError(404, 'FILE_NOT_FOUND');
    const b = opts.body as { category: string };
    const cat = getCategoryByKey(d, b.category);
    if (!cat) throw new ApiError(404, 'CATEGORY_NOT_FOUND');
    if (file.channelId == null || file.messageId == null) throw new ApiError(409, 'NOT_UPLOADED');
    if (cat.id === file.categoryId) return { file } as T;
    const g = needGateway();
    const staging = await tempFile('mv');
    try {
      await g.downloadFile(file.channelId, file.messageId, staging);
      const data = Buffer.from(await FileSystem.readAsStringAsync(staging, { encoding: 'base64' }), 'base64');
      const sent = await sendToCategory(g, d, cat.key, cat.label, data, file.name);
      await g.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
      const updated = moveFileCategory(d, id, cat.key, { channelId: sent.groupId, messageId: sent.messageId })!;
      recordActivity(d, 'file.moved', { id, to: cat.key });
      return { file: updated } as T;
    } catch (err) {
      mapTelegramToApi(err);
    } finally {
      await cleanup(staging);
    }
  }
  if (seg[0] === 'files' && seg.length === 2 && M === 'DELETE') {
    const id = Number(seg[1]);
    const file = getFileById(d, id);
    if (!file) throw new ApiError(404, 'FILE_NOT_FOUND');
    if (file.channelId != null && file.messageId != null && gateway) {
      await gateway.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
    }
    deleteFile(d, id);
    recordActivity(d, 'file.deleted', { id, name: file.name });
    return { ok: true } as T;
  }

  // ---- SEARCH ----
  if (seg[0] === 'search' && M === 'GET') {
    const q = parseQuery(query.get('q') ?? '');
    return { parsed: q, results: searchFiles(d, q) } as T;
  }

  // ---- STATS / ACTIVITY ----
  if (seg[0] === 'stats' && M === 'GET') return getStats(d) as T;
  if (seg[0] === 'activity' && M === 'GET') return { activity: listActivity(d, Number(query.get('limit') ?? '50')) } as T;

  // ---- ALBUM ----
  if (seg[0] === 'albums' && seg.length === 1 && M === 'GET') return { albums: listAlbums(d) } as T;
  if (seg[0] === 'albums' && seg.length === 1 && M === 'POST') {
    const b = opts.body as { name: string };
    return { album: createAlbum(d, b.name) } as T;
  }
  if (seg[0] === 'albums' && seg.length === 2 && M === 'PATCH') {
    const b = opts.body as { name: string };
    return { album: renameAlbum(d, Number(seg[1]), b.name) } as T;
  }
  if (seg[0] === 'albums' && seg.length === 2 && M === 'DELETE') {
    deleteAlbum(d, Number(seg[1]));
    return { ok: true } as T;
  }
  if (seg[0] === 'albums' && seg.length === 3 && seg[2] === 'files' && M === 'GET') {
    return { files: listAlbumFiles(d, Number(seg[1])) } as T;
  }
  if (seg[0] === 'albums' && seg.length === 3 && seg[2] === 'files' && M === 'POST') {
    const b = opts.body as { fileIds: number[] };
    const added = addToAlbum(d, Number(seg[1]), b.fileIds);
    return { added, files: listAlbumFiles(d, Number(seg[1])) } as T;
  }
  if (seg[0] === 'albums' && seg.length === 4 && seg[2] === 'files' && M === 'DELETE') {
    removeFromAlbum(d, Number(seg[1]), Number(seg[3]));
    return { ok: true } as T;
  }

  // ---- Karantina: WA / devices ----
  if (seg[0] === 'wa') return { state: 'disconnected', qr: null, phone: null, lastError: null } as T;
  if (seg[0] === 'devices') return { devices: [] } as T;

  throw new ApiError(404, 'NOT_FOUND');
}

/**
 * Unduh file drive (by id) ke path lokal, kembalikan path + mime. Meniru alur
 * server: unduh dari Telegram → tulis file temp. Dipakai preview + download.
 */
export async function materializeFile(id: number): Promise<{ path: string; mime: string; name: string }> {
  const d = await database();
  const file = getFileById(d, id);
  if (!file) throw new ApiError(404, 'FILE_NOT_FOUND');
  if (file.channelId == null || file.messageId == null) throw new ApiError(409, 'NOT_UPLOADED');
  const g = needGateway();
  const dest = await tempFile('dl');
  await g.downloadFile(file.channelId, file.messageId, dest);
  return { path: dest, mime: file.mime ?? 'application/octet-stream', name: file.name };
}

/** Simpan file drive (by id) ke lokasi tujuan permanen (folder unduhan/dokumen). */
export async function downloadFileTo(id: number, destDir: string): Promise<string> {
  const { path, name } = await materializeFile(id);
  const dest = `${destDir}${name}`;
  try {
    await FileSystem.copyAsync({ from: path, to: dest });
    return dest;
  } finally {
    await cleanup(path);
  }
}

/**
 * URI preview `file://` dari cache (sinkron) — null bila belum pernah diunduh.
 * Dipakai fileDownloadUrl() di src/api.ts untuk <Image> native.
 */
export function getPreviewUri(id: number): string | null {
  return previewUriCache.get(id) ?? null;
}

/**
 * Materialisasi preview: unduh dari Telegram SEKALI per file lalu cache path-nya.
 * Bila path cache sudah terhapus OS (cache dir), unduh ulang.
 */
export async function materializePreview(id: number): Promise<string> {
  const cached = previewUriCache.get(id);
  if (cached) {
    const info = await FileSystem.getInfoAsync(cached).catch(() => null);
    if (info?.exists) return cached;
    previewUriCache.delete(id);
  }
  const { path } = await materializeFile(id);
  previewUriCache.set(id, path);
  return path;
}

export { getDriveGroup, saveDriveGroup, clearDriveGroup, resetCategoryTopics };
