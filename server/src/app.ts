import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { parseQuery, classifyFile, CATEGORY_LABELS, type FileCategory } from '@td/shared';
import {
  initDb, ensureCategories, listCategories, getCategoryByKey, upsertCategoryTopic,
  insertFile, searchFiles, listFiles, enqueueSync, getSyncStats, getFileById,
  saveSession, getSession, deleteSession,
  getDriveGroup, saveDriveGroup, clearDriveGroup, resetCategoryTopics,
  upsertDevice, listDevices, deleteDevice, saveRefreshToken, findRefreshToken,
  revokeRefreshToken, revokeAllTokensForDevice,
  savePairingCode, getPairingCode, claimPairingCode, cleanupExpiredPairing,
  updateFile, deleteFile, moveFileCategory, logActivity, listActivity, getStats,
  listAlbums, createAlbum, getAlbum, renameAlbum, deleteAlbum, addToAlbum, removeFromAlbum, listAlbumFiles,
} from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { mapTelegramError, type TelegramFactory, type TelegramGateway, createRealGateway } from './telegram.js';
import { buildXlsxBuffer } from './sync.js';
import { createZipStream } from './zip.js';
import { SseHub } from './sse.js';
import type { AppConfig } from './config.js';

export interface BuildAppOptions {
  dbPath?: string;
  config: Pick<AppConfig, 'MAX_FILE_BYTES'> & { TURNO_SECRET_KEY: string };
  gatewayFactory?: TelegramFactory;
}

const AUTH_TTL_MS = 10 * 60 * 1000;
const ACCESS_TTL = '30d';
const REFRESH_TTL_DAYS = 30;
const REFRESH_COOKIE = 'td_refresh';

/** Hash SHA-256 → hex (untuk menyimpan refresh token di DB tanpa plaintext). */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Parse header Cookie mentah → objek. */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Set cookie refresh httpOnly (path /, maxAge 30 hari). Secure hanya bila https. */
function setRefreshCookie(reply: FastifyReply, token: string, secure: boolean): void {
  const attrs = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${REFRESH_TTL_DAYS * 24 * 60 * 60}`,
  ];
  if (secure) attrs.push('Secure');
  reply.header('set-cookie', attrs.join('; '));
}

function clearRefreshCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${REFRESH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

/** Satu grup forum tunggal; tiap kategori jadi topik di dalamnya. */
export const DRIVE_GROUP_TITLE = 'Telegram Drive';
export const DRIVE_GROUP_ABOUT = 'Gudang file pribadi — tiap kategori jadi topik.';

const StartSchema = z.object({
  apiId: z.number().int().positive(),
  apiHash: z.string().min(10),
  phone: z.string().regex(/^\+?\d{8,16}$/, 'nomor telepon tidak valid'),
});

interface PendingAuth {
  gateway: TelegramGateway;
  phone: string;
  phoneCodeHash: string;
  apiId: number;
  apiHash: string;
  createdAt: number;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const db = initDb(opts.dbPath ?? ':memory:');
  ensureCategories(db);
  const factory = opts.gatewayFactory ?? createRealGateway;
  const secret = new TextEncoder().encode(opts.config.TURNO_SECRET_KEY);
  const jwtKey = secret; // JWT memakai secret yang sama (personal-use)
  const pending = new Map<string, PendingAuth>();
  let cachedGateway: TelegramGateway | null = null;
  const hub = new SseHub();

  /** Catat aktivitas + push realtime ke semua klien SSE. */
  const recordActivity = (type: string, detail?: unknown, id?: number): void => {
    logActivity(db, type, detail);
    hub.broadcast(type, detail, id);
  };

  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });
  void app.register(multipart, { limits: { fileSize: opts.config.MAX_FILE_BYTES, files: 1 } });

  // ---- helper ----
  const issueAccessToken = async (): Promise<string> =>
    new SignJWT({ sub: '1' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt().setExpirationTime(ACCESS_TTL).sign(jwtKey);

  /**
   * Terbitkan pasangan akses + refresh untuk sebuah device. Refresh token mentah
   * hanya dikembalikan ke client (untuk cookie httpOnly); yang disimpan di DB
   * hanya hash-nya. Akses token berumur 30 hari (personal-use).
   */
  const issueTokens = async (deviceId: number): Promise<{ accessToken: string; refreshToken: string }> => {
    const refreshToken = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 86400_000).toISOString();
    saveRefreshToken(db, sha256(refreshToken), deviceId, expiresAt);
    const accessToken = await issueAccessToken();
    return { accessToken, refreshToken };
  };

  /** Deteksi apakah request datang dari https (untuk flag Secure cookie). */
  const isSecure = (req: FastifyRequest): boolean => {
    const proto = req.headers['x-forwarded-proto'];
    if (typeof proto === 'string') return proto.split(',')[0]!.trim() === 'https';
    return req.protocol === 'https';
  };

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const q = req.query as { token?: unknown };
    const queryToken = typeof q.token === 'string' ? q.token : '';
    const cookieToken = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    // Urutan prioritas: Bearer (mobile) → ?token= (link/gambar) → cookie (web).
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const token = bearer || queryToken || cookieToken;
    if (!token) { await reply.code(401).send({ error: 'UNAUTHORIZED' }); return; }
    try {
      const { payload } = await jwtVerify(token, jwtKey);
      if (payload.sub !== '1') throw new Error('bad sub');
    } catch {
      await reply.code(401).send({ error: 'UNAUTHORIZED' });
    }
  };

  const getGateway = async (): Promise<TelegramGateway | null> => {
    if (cachedGateway) return cachedGateway;
    const row = getSession(db);
    if (!row?.session_enc) return null;
    const apiHash = decrypt(row.api_hash_enc, opts.config.TURNO_SECRET_KEY);
    const session = decrypt(row.session_enc, opts.config.TURNO_SECRET_KEY);
    cachedGateway = await factory(row.api_id, apiHash, session);
    return cachedGateway;
  };

  const sendMappedError = async (reply: FastifyReply, err: unknown): Promise<void> => {
    // Log error asli dulu — tanpa ini, akar masalah tak terlihat dari mana pun.
    console.error('[auth] telegram error asli:', err instanceof Error ? `${err.name}: ${err.message}` : err);
    const mapped = mapTelegramError(err);
    const status = mapped.code === 'FLOOD_WAIT' ? 429
      : mapped.code === 'PHONE_CODE_INVALID' || mapped.code === 'PASSWORD_INVALID' ? 401 : 400;
    await reply.code(status).send({ error: mapped.code, retryAfterSeconds: mapped.retryAfterSeconds });
  };

  /** Grup/topik hilang dari Telegram (mis. dihapus user) — bukan masalah data. */
  const isPeerGone = (err: unknown): boolean =>
    /PEER_ID_INVALID|CHANNEL_PRIVATE|CHANNEL_INVALID|CHAT_ADMIN_REQUIRED/i.test(
      String(err instanceof Error ? err.message : err),
    );

  /**
   * Pastikan grup forum + topik kategori siap, lalu kirim file ke topik.
   * Idempoten: grup/topik di-cache di DB; kalau peer hilang → reset cache + coba
   * sekali lagi dengan grup/topik segar.
   */
  const sendToCategory = async (
    gateway: TelegramGateway, category: string, label: string, tempPath: string, name: string,
  ): Promise<{ groupId: number; topicId: number; messageId: number }> => {
    const attempt = async () => {
      let group = getDriveGroup(db);
      if (!group) {
        const created = await gateway.ensureDriveGroup(DRIVE_GROUP_TITLE, DRIVE_GROUP_ABOUT);
        group = { groupId: created.groupId, groupTitle: created.title };
        saveDriveGroup(db, group);
      }
      const groupId = group.groupId;
      const cat = getCategoryByKey(db, category)!;
      let topicId = cat.channel_id;
      if (topicId == null) {
        const topic = await gateway.ensureTopic(groupId, label);
        upsertCategoryTopic(db, category, topic.topicId, topic.title);
        topicId = topic.topicId;
      }
      const sent = await gateway.sendFileToTopic(groupId, topicId, tempPath, name);
      return { groupId, topicId, messageId: sent.messageId };
    };
    try {
      return await attempt();
    } catch (err) {
      if (!isPeerGone(err)) throw err;
      clearDriveGroup(db);
      resetCategoryTopics(db);
      return attempt(); // sekali lagi dengan grup/topik segar
    }
  };

  const finalizeLogin = async (
    flow: PendingAuth, requestId: string, req: FastifyRequest, reply: FastifyReply,
  ): Promise<{ token: string; refreshToken: string; me: unknown }> => {
    const me = await flow.gateway.getMe();
    saveSession(db, {
      apiId: flow.apiId,
      apiHashEnc: encrypt(flow.apiHash, opts.config.TURNO_SECRET_KEY),
      sessionEnc: encrypt(flow.gateway.sessionString(), opts.config.TURNO_SECRET_KEY),
      phone: flow.phone,
      tgUserId: me.id,
      tgName: me.firstName,
    });
    // Catat device + terbitkan akses & refresh (cookie httpOnly untuk web).
    const ua = req.headers['user-agent'] ?? null;
    const device = upsertDevice(db, req.body && (req.body as { deviceLabel?: string }).deviceLabel
      ? String((req.body as { deviceLabel?: string }).deviceLabel) : (ua ?? 'unknown'), ua);
    const { accessToken, refreshToken } = await issueTokens(device.id);
    setRefreshCookie(reply, refreshToken, isSecure(req));
    flow.gateway.destroy();
    pending.delete(requestId);
    return { token: accessToken, refreshToken, me };
  };

  // ---- routes: auth ----
  app.post('/auth/start', async (req, reply) => {
    const body = StartSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'VALIDATION', details: body.error.issues });
    const { apiId, apiHash, phone } = body.data;
    try {
      const gateway = await factory(apiId, apiHash);
      const { phoneCodeHash } = await gateway.sendCode(phone);
      const requestId = randomUUID();
      pending.set(requestId, { gateway, phone, phoneCodeHash, apiId, apiHash, createdAt: Date.now() });
      return { requestId };
    } catch (err) {
      return sendMappedError(reply, err);
    }
  });

  const getFlow = (requestId: string): PendingAuth | null => {
    const flow = pending.get(requestId);
    if (!flow) return null;
    if (Date.now() - flow.createdAt > AUTH_TTL_MS) {
      flow.gateway.destroy();
      pending.delete(requestId);
      return null;
    }
    return flow;
  };

  app.post('/auth/verify', async (req, reply) => {
    const body = z.object({ requestId: z.string(), code: z.string().min(3) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'VALIDATION' });
    const flow = getFlow(body.data.requestId);
    if (!flow) return reply.code(404).send({ error: 'FLOW_EXPIRED' });
    try {
      const res = await flow.gateway.signIn(flow.phone, flow.phoneCodeHash, body.data.code);
      if (res.twoFa) return { status: 'password_required' };
      return finalizeLogin(flow, body.data.requestId, req, reply);
    } catch (err) {
      return sendMappedError(reply, err);
    }
  });

  app.post('/auth/password', async (req, reply) => {
    const body = z.object({ requestId: z.string(), password: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'VALIDATION' });
    const flow = getFlow(body.data.requestId);
    if (!flow) return reply.code(404).send({ error: 'FLOW_EXPIRED' });
    try {
      await flow.gateway.checkPassword(body.data.password);
      return finalizeLogin(flow, body.data.requestId, req, reply);
    } catch (err) {
      return sendMappedError(reply, err);
    }
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async (req, reply) => {
    // Cabut refresh token milik device ini (kalau ada) + clear cookie.
    const cookieRefresh = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    if (cookieRefresh) revokeRefreshToken(db, sha256(cookieRefresh));
    cachedGateway?.destroy();
    cachedGateway = null;
    deleteSession(db);
    clearRefreshCookie(reply);
    return { ok: true };
  });

  /**
   * Rotasi refresh token: tukar refresh lama → pasangan akses + refresh baru.
   * Menerima refresh dari cookie httpOnly ATAU body (mobile). Token lama dicabut.
   */
  app.post('/auth/refresh', async (req, reply) => {
    const bodyRefresh = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
    const cookieRefresh = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    const raw = typeof bodyRefresh === 'string' ? bodyRefresh : cookieRefresh;
    if (!raw) return reply.code(401).send({ error: 'NO_REFRESH_TOKEN' });
    const row = findRefreshToken(db, sha256(raw));
    if (!row || row.revokedAt || new Date(row.expiresAt).getTime() < Date.now()) {
      clearRefreshCookie(reply);
      return reply.code(401).send({ error: 'REFRESH_INVALID' });
    }
    revokeRefreshToken(db, sha256(raw)); // rotasi: token lama tak bisa dipakai lagi
    const deviceId = row.deviceId ?? upsertDevice(db, req.headers['user-agent'] ?? 'unknown', req.headers['user-agent'] ?? null).id;
    const { accessToken, refreshToken } = await issueTokens(deviceId);
    setRefreshCookie(reply, refreshToken, isSecure(req));
    return { token: accessToken, refreshToken };
  });

  // ---- routes: devices (manajemen sesi per-perangkat) ----
  app.get('/devices', { preHandler: requireAuth }, async () => ({ devices: listDevices(db) }));

  app.delete('/devices/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const device = listDevices(db).find((d) => d.id === id);
    if (!device) return reply.code(404).send({ error: 'DEVICE_NOT_FOUND' });
    revokeAllTokensForDevice(db, id);
    deleteDevice(db, id);
    return { ok: true };
  });

  // ---- routes: pairing (login web dengan scan QR dari HP yang sudah masuk) ----
  // Rate-limit sederhana in-memory: 5 kode/menit per proses (personal-use).
  const pairingWindow: number[] = [];
  const PAIRING_TTL_MS = 5 * 60 * 1000;
  const PAIRING_RATE = 5;
  const PAIRING_WINDOW_MS = 60_000;

  /** Buat kode pairing (dipanggil HP yang sudah login; kode ini yang digambar jadi QR). */
  app.post('/auth/pairing', { preHandler: requireAuth }, async (req, reply) => {
    const now = Date.now();
    while (pairingWindow.length && now - pairingWindow[0]! > PAIRING_WINDOW_MS) pairingWindow.shift();
    if (pairingWindow.length >= PAIRING_RATE) return reply.code(429).send({ error: 'RATE_LIMITED' });
    pairingWindow.push(now);
    cleanupExpiredPairing(db);
    const code = randomBytes(5).toString('hex'); // 10 hex char → cukup unik & pendek untuk QR
    const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
    const label = (req.body as { deviceLabel?: string } | undefined)?.deviceLabel ?? 'Web';
    savePairingCode(db, code, expiresAt, label);
    return { code, expiresIn: Math.floor(PAIRING_TTL_MS / 1000) };
  });

  /** Poll status dari web: pending → claimed (lalu ambil token sekali di /claim). */
  app.get('/auth/pairing/:code', async (req, reply) => {
    const { code } = z.object({ code: z.string().min(4).max(32) }).parse(req.params);
    const row = getPairingCode(db, code);
    if (!row) return reply.code(404).send({ error: 'PAIRING_NOT_FOUND' });
    if (new Date(row.expiresAt).getTime() < Date.now()) return reply.code(410).send({ error: 'PAIRING_EXPIRED' });
    return { status: row.claimedAt ? 'claimed' : 'pending' };
  });

  /** Tukar kode pairing → token (single-use atomik). Menyetel cookie refresh httpOnly. */
  app.post('/auth/pairing/:code/claim', async (req, reply) => {
    const { code } = z.object({ code: z.string().min(4).max(32) }).parse(req.params);
    const row = getPairingCode(db, code);
    if (!row) return reply.code(404).send({ error: 'PAIRING_NOT_FOUND' });
    if (new Date(row.expiresAt).getTime() < Date.now()) return reply.code(410).send({ error: 'PAIRING_EXPIRED' });
    // Klaim atomik: hanya pemenang pertama yang lolos (single-use).
    if (!claimPairingCode(db, code)) return reply.code(410).send({ error: 'PAIRING_CONSUMED' });
    const ua = req.headers['user-agent'] ?? null;
    const device = upsertDevice(db, row.deviceLabel ?? 'Web', ua);
    const { accessToken, refreshToken } = await issueTokens(device.id);
    setRefreshCookie(reply, refreshToken, isSecure(req));
    return { token: accessToken, refreshToken };
  });

  app.get('/me', { preHandler: requireAuth }, async (req, reply) => {
    const gateway = await getGateway();
    if (!gateway) return reply.code(401).send({ error: 'NOT_LOGGED_IN' });
    try {
      const me = await gateway.getMe();
      return { me, phone: getSession(db)?.phone ?? null };
    } catch (err) {
      return sendMappedError(reply, err);
    }
  });

  // ---- routes: files ----
  app.post('/files', { preHandler: requireAuth }, async (req, reply) => {
    const gateway = await getGateway();
    if (!gateway) return reply.code(401).send({ error: 'NOT_LOGGED_IN' });
    if (!req.isMultipart()) return reply.code(400).send({ error: 'EXPECT_MULTIPART' });

    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'NO_FILE' });

    const tempPath = join(tmpdir(), `td-upload-${randomUUID()}`);
    try {
      await pipeline(part.file, createWriteStream(tempPath));
      const size = part.file.bytesRead;

      const { category } = classifyFile(part.mimetype ?? '', part.filename ?? '');
      const label = CATEGORY_LABELS[category as FileCategory];
      const cat = getCategoryByKey(db, category)!;
      const name = part.filename ?? 'file';
      const dot = name.lastIndexOf('.');
      const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : null;

      const sent = await sendToCategory(gateway, category, label, tempPath, name);

      const file = insertFile(db, {
        fileUid: randomUUID(), name, ext, mime: part.mimetype ?? null, size,
        uploadedAt: new Date().toISOString(), categoryId: cat.id,
        channelId: sent.groupId, messageId: sent.messageId,
      });
      enqueueSync(db, file.id);
      recordActivity('file.uploaded', { id: file.id, name: file.name, categoryKey: file.categoryKey, size: file.size });
      return { file };
    } catch (err) {
      return sendMappedError(reply, err);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  });

  app.get('/files', { preHandler: requireAuth }, async (req) => {
    const q = z.object({
      category: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const cat = q.category ? getCategoryByKey(db, q.category) : undefined;
    return { files: listFiles(db, { categoryId: cat?.id, limit: q.limit, offset: q.offset }) };
  });

  app.get('/search', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ q: z.string().default(''), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const parsed = parseQuery(q.q);
    return { parsed, results: searchFiles(db, parsed, q.limit) };
  });

  app.get('/categories', { preHandler: requireAuth }, async () => ({ categories: listCategories(db) }));

  /**
   * Unduh file dari Telegram → stream ke client (disposition: attachment).
   * Menerima auth lewat header Bearer ATAU ?token= (untuk <img>/link langsung).
   */
  app.get('/files/:id/download', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const file = getFileById(db, id);
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    if (file.channelId == null || file.messageId == null) return reply.code(409).send({ error: 'NOT_UPLOADED' });
    const gateway = await getGateway();
    if (!gateway) return reply.code(401).send({ error: 'NOT_LOGGED_IN' });

    const tempPath = join(tmpdir(), `td-dl-${randomUUID()}`);
    try {
      await gateway.downloadFile(file.channelId, file.messageId, tempPath);
      const asciiName = file.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
      const stream = createReadStream(tempPath);
      stream.on('close', () => void unlink(tempPath).catch(() => undefined));
      return reply
        .header('content-type', file.mime ?? 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`)
        .send(stream);
    } catch (err) {
      await unlink(tempPath).catch(() => undefined);
      return sendMappedError(reply, err);
    }
  });

  app.get('/sync/status', { preHandler: requireAuth }, async () => getSyncStats(db));

  /** Preview inline (disposition: inline) — dipakai drawer untuk gambar/audio/video/pdf. */
  app.get('/files/:id/preview', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const file = getFileById(db, id);
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    if (file.channelId == null || file.messageId == null) return reply.code(409).send({ error: 'NOT_UPLOADED' });
    const gateway = await getGateway();
    if (!gateway) return reply.code(401).send({ error: 'NOT_LOGGED_IN' });
    const tempPath = join(tmpdir(), `td-prev-${randomUUID()}`);
    try {
      await gateway.downloadFile(file.channelId, file.messageId, tempPath);
      const stream = createReadStream(tempPath);
      stream.on('close', () => void unlink(tempPath).catch(() => undefined));
      return reply
        .header('content-type', file.mime ?? 'application/octet-stream')
        .header('content-disposition', 'inline')
        .header('cache-control', 'private, max-age=3600')
        .send(stream);
    } catch (err) {
      await unlink(tempPath).catch(() => undefined);
      return sendMappedError(reply, err);
    }
  });

  /** Rename tampilan &/atau ubah tag file. */
  app.patch('/files/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({
      displayName: z.string().max(300).nullable().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: 'VALIDATION', details: body.error.issues });
    const file = getFileById(db, id);
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    // Nama tampilan kosong/spasi → tolak (pakai null untuk "hapus rename").
    if (body.data.displayName !== undefined && body.data.displayName !== null && body.data.displayName.trim() === '') {
      return reply.code(422).send({ error: 'VALIDATION', details: [{ message: 'displayName kosong' }] });
    }
    const updated = updateFile(db, id, body.data)!;
    // Sinkronkan caption Telegram (best-effort — tak memblokir bila gagal).
    if (body.data.displayName !== undefined && file.channelId != null && file.messageId != null) {
      const gateway = await getGateway();
      if (gateway) {
        await gateway.editCaption(file.channelId, file.messageId, updated.displayName ?? updated.name)
          .catch(() => undefined);
      }
    }
    recordActivity('file.updated', { id, displayName: updated.displayName, tags: updated.tags });
    return { file: updated };
  });

  /** Hapus file dari drive (DB) + hapus pesan Telegram (best-effort). */
  app.delete('/files/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const file = getFileById(db, id);
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    if (file.channelId != null && file.messageId != null) {
      const gateway = await getGateway();
      if (gateway) await gateway.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
    }
    deleteFile(db, id);
    recordActivity('file.deleted', { id, name: file.name });
    return { ok: true };
  });

  /**
   * Pindahkan file ke kategori lain. Strategi "aman": kirim salinan ke topik
   * baru dulu; hanya hapus pesan lama & update DB setelah kirim sukses.
   * Kalau gagal di tengah, file lama tetap utuh (tak pernah kehilangan file).
   */
  app.patch('/files/:id/category', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    const body = z.object({ category: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: 'VALIDATION' });
    const file = getFileById(db, id);
    if (!file) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });
    const cat = getCategoryByKey(db, body.data.category);
    if (!cat) return reply.code(404).send({ error: 'CATEGORY_NOT_FOUND' });
    if (file.channelId == null || file.messageId == null) return reply.code(409).send({ error: 'NOT_UPLOADED' });
    if (cat.id === file.categoryId) return { file }; // sudah di kategori itu
    const gateway = await getGateway();
    if (!gateway) return reply.code(401).send({ error: 'NOT_LOGGED_IN' });

    const tempPath = join(tmpdir(), `td-move-${randomUUID()}`);
    try {
      await gateway.downloadFile(file.channelId, file.messageId, tempPath);
      const dest = await sendToCategory(gateway, cat.key, cat.label, tempPath, file.name);
      // salinan sudah aman → hapus pesan lama (best-effort) lalu pindahkan baris DB
      await gateway.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
      const updated = moveFileCategory(db, id, cat.key, { channelId: dest.groupId, messageId: dest.messageId })!;
      recordActivity('file.moved', { id, to: cat.key });
      return { file: updated };
    } catch (err) {
      return sendMappedError(reply, err);
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  });

  /**
   * Unduh massal sebagai satu arsip ZIP (streaming, method STORE — file Telegram
   * sudah terkompresi). Maksimal 20 file per request (batas personal-use).
   * Satu file gagal diunduh → entri dilewati (tak mematikan seluruh stream).
   */
  app.get('/files/zip', { preHandler: requireAuth }, async (req, reply) => {
    const q = z.object({ ids: z.string().min(1).max(1000) }).safeParse(req.query);
    if (!q.success) return reply.code(422).send({ error: 'VALIDATION', details: q.error.issues });
    const ids = [...new Set(q.data.ids.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))];
    if (ids.length === 0) return reply.code(422).send({ error: 'VALIDATION', details: [{ message: 'ids kosong' }] });
    if (ids.length > 20) return reply.code(422).send({ error: 'VALIDATION', details: [{ message: 'maksimal 20 file per arsip' }] });
    const gateway = await getGateway();
    if (!gateway) return reply.code(401).send({ error: 'NOT_LOGGED_IN' });

    const files = ids
      .map((id) => getFileById(db, id))
      .filter((f): f is NonNullable<typeof f> => f != null && f.channelId != null && f.messageId != null);
    if (files.length === 0) return reply.code(404).send({ error: 'FILE_NOT_FOUND' });

    const stream = createZipStream(
      files.map((f) => ({
        name: f.name,
        fetch: async (dest: string): Promise<boolean> => {
          await gateway.downloadFile(f.channelId!, f.messageId!, dest);
          return true;
        },
      })),
      tmpdir(),
    );
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', 'attachment; filename="telegram-drive-batch.zip"')
      .send(stream);
  });

  /**
   * Aksi massal. Jalan serial, hasil per-id (satu gagal tak menggagalkan lain).
   * action: delete | move | tag
   */
  app.post('/files/batch', { preHandler: requireAuth }, async (req, reply) => {
    const body = z.object({
      action: z.enum(['delete', 'move', 'tag']),
      ids: z.array(z.number().int().positive()).min(1).max(50),
      category: z.string().optional(),
      tags: z.array(z.string().min(1).max(40)).max(20).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(422).send({ error: 'VALIDATION', details: body.error.issues });
    const { action, ids } = body.data;
    if (action === 'move' && !body.data.category) return reply.code(422).send({ error: 'VALIDATION', details: [{ message: 'move butuh category' }] });
    if (action === 'tag' && !body.data.tags) return reply.code(422).send({ error: 'VALIDATION', details: [{ message: 'tag butuh tags' }] });

    const gateway = await getGateway();
    const results: Array<{ id: number; ok: boolean; error?: string }> = [];
    for (const id of [...new Set(ids)]) {
      const file = getFileById(db, id);
      if (!file) { results.push({ id, ok: false, error: 'FILE_NOT_FOUND' }); continue; }
      try {
        if (action === 'delete') {
          if (gateway && file.channelId != null && file.messageId != null) {
            await gateway.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
          }
          deleteFile(db, id);
          recordActivity('file.deleted', { id, name: file.name });
        } else if (action === 'move') {
          const cat = getCategoryByKey(db, body.data.category!)!;
          if (!gateway) { results.push({ id, ok: false, error: 'NOT_LOGGED_IN' }); continue; }
          if (file.channelId == null || file.messageId == null) { results.push({ id, ok: false, error: 'NOT_UPLOADED' }); continue; }
          if (cat.id === file.categoryId) { results.push({ id, ok: true }); continue; }
          const tempPath = join(tmpdir(), `td-bmove-${randomUUID()}`);
          try {
            await gateway.downloadFile(file.channelId, file.messageId, tempPath);
            const dest = await sendToCategory(gateway, cat.key, cat.label, tempPath, file.name);
            await gateway.deleteMessages(file.channelId, [file.messageId]).catch(() => undefined);
            moveFileCategory(db, id, cat.key, { channelId: dest.groupId, messageId: dest.messageId });
            recordActivity('file.moved', { id, to: cat.key });
          } finally {
            await unlink(tempPath).catch(() => undefined);
          }
        } else if (action === 'tag') {
          updateFile(db, id, { tags: body.data.tags! });
          recordActivity('file.updated', { id, tags: body.data.tags });
        }
        results.push({ id, ok: true });
      } catch (err) {
        const mapped = mapTelegramError(err);
        results.push({ id, ok: false, error: mapped.code });
      }
    }
    return { results };
  });

  app.get('/logs.xlsx', { preHandler: requireAuth }, async (req, reply) => {
    const buf = await buildXlsxBuffer(db);
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="telegram-drive-manifest.xlsx"')
      .send(buf);
  });

  // ---- routes: statistik & riwayat aktivitas ----

  /** Dasbor penyimpanan: total, per kategori, per ekstensi, per sumber. */
  app.get('/stats', { preHandler: requireAuth }, async () => getStats(db));

  /** Riwayat aktivitas (terbaru dulu). */
  app.get('/activity', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().positive().max(200).default(50) }).safeParse(req.query);
    const limit = q.success ? q.data.limit : 50;
    return { activity: listActivity(db, limit) };
  });

  /**
   * SSE: push realtime (file baru, status WhatsApp, sinkron selesai).
   * Auth via ?token= (EventSource tak bisa set header Authorization).
   * Klien wajib tangani reconnect; Last-Event-ID dipakai resume bila perlu.
   */
  app.get('/events', { preHandler: requireAuth }, async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    reply.raw.write('retry: 3000\n\n');
    // heartbeat tiap 25 detik agar koneksi tak dianggap idle oleh proxy
    const heartbeat = setInterval(() => { try { reply.raw.write(': ping\n\n'); } catch { /* noop */ } }, 25_000);
    const unsubscribe = hub.subscribe(reply);
    reply.raw.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
    // biar Fastify tidak menutup reply secara otomatis
    return reply;
  });

  app.get('/health', async () => ({ ok: true }));

  app.addHook('onClose', async () => { hub.closeAll(); });

  app.decorate('db', db);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: import('better-sqlite3').Database;
  }
}
