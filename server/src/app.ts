import { randomUUID } from 'node:crypto';
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
} from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { mapTelegramError, type TelegramFactory, type TelegramGateway, createRealGateway } from './telegram.js';
import { buildXlsxBuffer } from './sync.js';
import type { AppConfig } from './config.js';

export interface BuildAppOptions {
  dbPath?: string;
  config: Pick<AppConfig, 'MAX_FILE_BYTES'> & { TURNO_SECRET_KEY: string };
  gatewayFactory?: TelegramFactory;
}

const AUTH_TTL_MS = 10 * 60 * 1000;

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

  const app = Fastify({ logger: false });
  void app.register(cors, { origin: true });
  void app.register(multipart, { limits: { fileSize: opts.config.MAX_FILE_BYTES, files: 1 } });

  // ---- helper ----
  const issueToken = async (): Promise<string> =>
    new SignJWT({ sub: '1' }).setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt().setExpirationTime('30d').sign(jwtKey);

  const requireAuth = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const header = req.headers.authorization ?? '';
    const q = req.query as { token?: unknown };
    const queryToken = typeof q.token === 'string' ? q.token : '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : queryToken;
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

  const finalizeLogin = async (flow: PendingAuth, requestId: string): Promise<FastifyReply | { token: string; me: unknown }> => {
    const me = await flow.gateway.getMe();
    saveSession(db, {
      apiId: flow.apiId,
      apiHashEnc: encrypt(flow.apiHash, opts.config.TURNO_SECRET_KEY),
      sessionEnc: encrypt(flow.gateway.sessionString(), opts.config.TURNO_SECRET_KEY),
      phone: flow.phone,
      tgUserId: me.id,
      tgName: me.firstName,
    });
    flow.gateway.destroy();
    pending.delete(requestId);
    return { token: await issueToken(), me };
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
      return finalizeLogin(flow, body.data.requestId);
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
      return finalizeLogin(flow, body.data.requestId);
    } catch (err) {
      return sendMappedError(reply, err);
    }
  });

  app.post('/auth/logout', { preHandler: requireAuth }, async () => {
    cachedGateway?.destroy();
    cachedGateway = null;
    deleteSession(db);
    return { ok: true };
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

  app.get('/logs.xlsx', { preHandler: requireAuth }, async (req, reply) => {
    const buf = await buildXlsxBuffer(db);
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', 'attachment; filename="telegram-drive-manifest.xlsx"')
      .send(buf);
  });

  app.get('/health', async () => ({ ok: true }));

  app.decorate('db', db);
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: import('better-sqlite3').Database;
  }
}
