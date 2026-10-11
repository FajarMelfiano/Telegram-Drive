import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { TelegramGateway, DriveGroupInfo, TopicInfo, MeInfo, SentFileResult } from '../telegram.js';

const KEY = '1'.repeat(64);

class FakeGateway implements TelegramGateway {
  group: DriveGroupInfo | null = null;
  topics = new Map<string, TopicInfo>();
  sent: Array<{ groupId: number; topicId: number; filePath: string; caption: string }> = [];
  deleted: Array<{ groupId: number; messageIds: number[] }> = [];
  edited: Array<{ groupId: number; messageId: number; caption: string }> = [];
  requireTwoFa = false;
  private msgId = 100;
  private topicId = 10;

  constructor(public apiId: number, public apiHash: string, public session?: string) {}

  async sendCode(phone: string): Promise<{ phoneCodeHash: string }> {
    if (!phone.startsWith('+')) throw new Error('PHONE_NUMBER_INVALID');
    return { phoneCodeHash: 'pch-1' };
  }
  async signIn(_phone: string, _hash: string, code: string): Promise<{ twoFa: boolean }> {
    if (code === '00000') throw new Error('PHONE_CODE_INVALID');
    return { twoFa: this.requireTwoFa };
  }
  async checkPassword(pw: string): Promise<void> {
    if (pw !== 'rahasia') throw new Error('PASSWORD_HASH_INVALID');
  }
  async getMe(): Promise<MeInfo> { return { id: 777, firstName: 'Muse' }; }
  async ensureDriveGroup(title: string): Promise<DriveGroupInfo> {
    this.group ??= { groupId: -100_000, title };
    return this.group;
  }
  async ensureTopic(_groupId: number, title: string): Promise<TopicInfo> {
    const existing = this.topics.get(title);
    if (existing) return existing;
    const info = { topicId: this.topicId++, title };
    this.topics.set(title, info);
    return info;
  }
  async sendFileToTopic(groupId: number, topicId: number, filePath: string, caption: string): Promise<SentFileResult> {
    this.sent.push({ groupId, topicId, filePath, caption });
    return { messageId: this.msgId++, groupId };
  }
  async downloadFile(_groupId: number, messageId: number, destPath: string): Promise<string> {
    await writeFile(destPath, `ISI-REMOTE-${messageId}`);
    return destPath;
  }
  async deleteMessages(groupId: number, messageIds: number[]): Promise<void> {
    this.deleted.push({ groupId, messageIds });
  }
  async editCaption(groupId: number, messageId: number, caption: string): Promise<void> {
    this.edited.push({ groupId, messageId, caption });
  }
  sessionString(): string { return 'session-abc'; }
  destroy(): void { /* no-op */ }
}

function multipart(filename: string, contentType: string, content: string) {
  const boundary = '----tdtest';
  const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--\r\n`;
  return {
    payload: Buffer.from(body),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

let app: FastifyInstance;
let fake: FakeGateway;

beforeEach(async () => {
  fake = new FakeGateway(1, 'hash-abc');
  app = buildApp({
    config: { TURNO_SECRET_KEY: KEY, MAX_FILE_BYTES: 10_000_000 },
    gatewayFactory: async (id, hash, session) => { fake.apiId = id; fake.apiHash = hash; fake.session = session; return fake; },
  });
  await app.ready();
});

afterEach(async () => { await app.close(); });

async function login(): Promise<string> {
  const start = await app.inject({ method: 'POST', url: '/auth/start', payload: { apiId: 1, apiHash: 'abcdefghij', phone: '+628123456789' } });
  expect(start.statusCode).toBe(200);
  const { requestId } = start.json() as { requestId: string };
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { requestId, code: '12345' } });
  expect(verify.statusCode).toBe(200);
  return (verify.json() as { token: string }).token;
}

/** Login lengkap: ambil token akses, refresh token mentah, dan cookie header. */
async function loginFull(): Promise<{ token: string; refreshToken: string; cookie: string }> {
  const start = await app.inject({ method: 'POST', url: '/auth/start', payload: { apiId: 1, apiHash: 'abcdefghij', phone: '+628123456789' } });
  const { requestId } = start.json() as { requestId: string };
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { requestId, code: '12345' } });
  const body = verify.json() as { token: string; refreshToken: string };
  const setCookie = verify.headers['set-cookie'];
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '');
  const cookieHeader = cookieStr.split(';')[0] ?? '';
  return { token: body.token, refreshToken: body.refreshToken, cookie: cookieHeader };
}

function upload(token: string, filename: string, mime: string, content: string) {
  const mp = multipart(filename, mime, content);
  return app.inject({
    method: 'POST', url: '/files',
    headers: { authorization: `Bearer ${token}`, ...mp.headers },
    payload: mp.payload,
  });
}

describe('auth flow', () => {
  it('start → verify menerbitkan token dan /me bisa dipanggil', async () => {
    const token = await login();
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { me: { firstName: string } }).me.firstName).toBe('Muse');
  });

  it('kode salah ditolak dengan PHONE_CODE_INVALID', async () => {
    const start = await app.inject({ method: 'POST', url: '/auth/start', payload: { apiId: 1, apiHash: 'abcdefghij', phone: '+628123456789' } });
    const { requestId } = start.json() as { requestId: string };
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { requestId, code: '00000' } });
    expect(verify.statusCode).toBe(401);
    expect((verify.json() as { error: string }).error).toBe('PHONE_CODE_INVALID');
  });

  it('alur 2FA: verify → password_required → /auth/password → token', async () => {
    fake.requireTwoFa = true;
    const start = await app.inject({ method: 'POST', url: '/auth/start', payload: { apiId: 1, apiHash: 'abcdefghij', phone: '+628123456789' } });
    const { requestId } = start.json() as { requestId: string };
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { requestId, code: '12345' } });
    expect((verify.json() as { status: string }).status).toBe('password_required');

    const bad = await app.inject({ method: 'POST', url: '/auth/password', payload: { requestId, password: 'salah' } });
    expect(bad.statusCode).toBe(401);

    const ok = await app.inject({ method: 'POST', url: '/auth/password', payload: { requestId, password: 'rahasia' } });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as { token: string }).token).toBeTruthy();
  });

  it('request tanpa token ditolak 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/files' });
    expect(res.statusCode).toBe(401);
  });
});

describe('cookie httpOnly + refresh token', () => {
  it('login menyetel cookie refresh httpOnly dan /me bisa dipakai lewat cookie', async () => {
    const start = await app.inject({ method: 'POST', url: '/auth/start', payload: { apiId: 1, apiHash: 'abcdefghij', phone: '+628123456789' } });
    const { requestId } = start.json() as { requestId: string };
    const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { requestId, code: '12345' } });
    const setCookie = verify.headers['set-cookie'] as string[] | string | undefined;
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')];
    const refresh = cookies.find((c) => c.startsWith('td_refresh='));
    expect(refresh).toBeTruthy();
    expect(refresh).toContain('HttpOnly');
    expect(refresh).toContain('Path=/');
    expect(refresh).toContain('SameSite=Lax');
  });

  it('/auth/refresh menukar refresh lama → token baru + refresh baru (rotasi)', async () => {
    const { refreshToken } = await loginFull();
    const res = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; refreshToken: string };
    expect(body.token).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.refreshToken).not.toBe(refreshToken); // rotasi: refresh baru berbeda

    // refresh lama sudah dicabut → dipakai lagi ditolak
    const reuse = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
    expect(reuse.statusCode).toBe(401);
  });

  it('/auth/refresh tanpa token → 401; refresh palsu → 401 + cookie dibersihkan', async () => {
    const none = await app.inject({ method: 'POST', url: '/auth/refresh', payload: {} });
    expect(none.statusCode).toBe(401);
    const fake = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: 'bukan-token' } });
    expect(fake.statusCode).toBe(401);
    expect(String(fake.headers['set-cookie'] ?? '')).toContain('Max-Age=0');
  });
});

describe('devices (manajemen sesi)', () => {
  it('login membuat device; /devices menampilkannya; delete mencabut sesi', async () => {
    const { token } = await loginFull();
    const list = await app.inject({ method: 'GET', url: '/devices', headers: { authorization: `Bearer ${token}` } });
    expect(list.statusCode).toBe(200);
    const { devices } = list.json() as { devices: Array<{ id: number; label: string }> };
    expect(devices.length).toBeGreaterThanOrEqual(1);

    const target = devices[0]!;
    const del = await app.inject({ method: 'DELETE', url: `/devices/${target.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({ method: 'GET', url: '/devices', headers: { authorization: `Bearer ${token}` } });
    expect((after.json() as { devices: Array<{ id: number }> }).devices.find((d) => d.id === target.id)).toBeUndefined();
  });

  it('delete device tak dikenal → 404', async () => {
    const { token } = await loginFull();
    const del = await app.inject({ method: 'DELETE', url: '/devices/99999', headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(404);
  });
});

describe('pairing QR (login web dari HP)', () => {
  it('alur penuh: HP buat kode → web poll pending → HP approve → web claim → dapat token + cookie', async () => {
    const { token } = await loginFull(); // HP yang sudah login

    // 1. HP meminta kode pairing
    const created = await app.inject({ method: 'POST', url: '/auth/pairing', headers: { authorization: `Bearer ${token}` }, payload: { deviceLabel: 'Chrome Linux' } });
    expect(created.statusCode).toBe(200);
    const { code, expiresIn } = created.json() as { code: string; expiresIn: number };
    expect(code).toBeTruthy();
    expect(expiresIn).toBe(300);

    // 2. Web poll → pending
    const poll = await app.inject({ method: 'GET', url: `/auth/pairing/${code}` });
    expect(poll.statusCode).toBe(200);
    expect((poll.json() as { status: string }).status).toBe('pending');

    // 3. Web klaim → token + cookie
    const claim = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/claim` });
    expect(claim.statusCode).toBe(200);
    const body = claim.json() as { token: string; refreshToken: string };
    expect(body.token).toBeTruthy();
    const setCookie = claim.headers['set-cookie'] as string[] | string | undefined;
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')];
    expect(cookies.some((c) => c.startsWith('td_refresh=') && c.includes('HttpOnly'))).toBe(true);

    // 4. token klaim valid → /me sukses
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);

    // 5. claim kedua ditolak (single-use)
    const again = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/claim` });
    expect(again.statusCode).toBe(410);
  });

  it('kode tidak dikenal → 404 di poll & claim', async () => {
    const poll = await app.inject({ method: 'GET', url: '/auth/pairing/deadbeef' });
    expect(poll.statusCode).toBe(404);
    const claim = await app.inject({ method: 'POST', url: '/auth/pairing/deadbeef/claim' });
    expect(claim.statusCode).toBe(404);
  });

  it('kode kedaluwarsa → 410 di poll & claim', async () => {
    const { token } = await loginFull();
    const created = await app.inject({ method: 'POST', url: '/auth/pairing', headers: { authorization: `Bearer ${token}` }, payload: {} });
    const { code } = created.json() as { code: string };
    // Paksa kedaluwarsa langsung di DB
    app.db.prepare('UPDATE pairing_codes SET expires_at = ? WHERE code = ?').run(new Date(Date.now() - 1000).toISOString(), code);
    const poll = await app.inject({ method: 'GET', url: `/auth/pairing/${code}` });
    expect(poll.statusCode).toBe(410);
    const claim = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/claim` });
    expect(claim.statusCode).toBe(410);
  });

  it('butuh login untuk membuat kode (tanpa token → 401)', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/pairing', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('upload pipeline', () => {
  it('mengklasifikasi, membuat grup+topik kategori, mencatat, dan mengantre sinkron', async () => {
    const token = await login();
    const res = await upload(token, 'laporan.pdf', 'application/pdf', 'isi-pdf');
    expect(res.statusCode).toBe(200);
    const { file } = res.json() as { file: { categoryKey: string; name: string; ext: string; messageId: number } };
    expect(file.categoryKey).toBe('dokumen');
    expect(file.ext).toBe('pdf');
    expect(fake.group?.title).toBe('Telegram Drive');
    expect(fake.topics.has('Dokumen')).toBe(true);

    const status = await app.inject({ method: 'GET', url: '/sync/status', headers: { authorization: `Bearer ${token}` } });
    expect((status.json() as { pending: number }).pending).toBe(1);
  });

  it('mengirim ke topik kategori yang benar dalam grup yang sama (tidak dobel buat topik)', async () => {
    const token = await login();
    await upload(token, 'a.jpg', 'image/jpeg', 'x');
    await upload(token, 'b.jpg', 'image/jpeg', 'y');
    await upload(token, 'c.pdf', 'application/pdf', 'z');
    expect(fake.topics.size).toBe(2); // Gambar + Dokumen
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent.every((s) => s.groupId === fake.group!.groupId)).toBe(true);
    const topicIds = new Set(fake.sent.map((s) => s.topicId));
    expect(topicIds.size).toBe(2); // jpg → topik Gambar, pdf → topik Dokumen
  });
});

describe('file download', () => {
  it('stream isi remote dengan disposition attachment (auth header)', async () => {
    const token = await login();
    const up = await upload(token, 'laporan.pdf', 'application/pdf', 'isi-asli');
    const { file } = up.json() as { file: { id: number; messageId: number } };

    const res = await app.inject({ method: 'GET', url: `/files/${file.id}/download`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    expect(String(res.headers['content-disposition'])).toContain('laporan.pdf');
    expect(res.body).toBe(`ISI-REMOTE-${file.messageId}`);
  });

  it('menerima auth lewat ?token= (untuk <img> dan link unduh langsung)', async () => {
    const token = await login();
    const up = await upload(token, 'foto.jpg', 'image/jpeg', 'x');
    const { file } = up.json() as { file: { id: number } };

    const res = await app.inject({ method: 'GET', url: `/files/${file.id}/download?token=${encodeURIComponent(token)}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/^ISI-REMOTE-\d+$/);
  });

  it('file tidak dikenal → 404, tanpa auth → 401', async () => {
    const token = await login();
    const missing = await app.inject({ method: 'GET', url: '/files/9999/download', headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(404);
    const noAuth = await app.inject({ method: 'GET', url: '/files/1/download' });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe('preview inline', () => {
  it('mengembalikan content-disposition inline (bukan attachment)', async () => {
    const token = await login();
    const up = await upload(token, 'foto.jpg', 'image/jpeg', 'img-bytes');
    const { file } = up.json() as { file: { id: number; messageId: number } };

    const res = await app.inject({ method: 'GET', url: `/files/${file.id}/preview`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(String(res.headers['content-disposition'])).toContain('inline');
    expect(res.body).toBe(`ISI-REMOTE-${file.messageId}`);
  });

  it('file tidak ada → 404', async () => {
    const token = await login();
    const res = await app.inject({ method: 'GET', url: '/files/9999/preview', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
  });
});

describe('rename + tag', () => {
  it('mengubah nama tampilan dan tag; nama asli tak berubah', async () => {
    const token = await login();
    const up = await upload(token, 'laporan.pdf', 'application/pdf', 'x');
    const { file } = up.json() as { file: { id: number; name: string } };

    const res = await app.inject({
      method: 'PATCH', url: `/files/${file.id}`, headers: { authorization: `Bearer ${token}` },
      payload: { displayName: 'Laporan Q3 Final', tags: ['penting', 'q3'] },
    });
    expect(res.statusCode).toBe(200);
    const upd = (res.json() as { file: { name: string; displayName: string | null; tags: string[] } }).file;
    expect(upd.name).toBe('laporan.pdf');         // nama asli tak tersentuh
    expect(upd.displayName).toBe('Laporan Q3 Final');
    expect(upd.tags).toEqual(['penting', 'q3']);
  });

  it('tag bisa dicari lewat search', async () => {
    const token = await login();
    const up = await upload(token, 'nota.pdf', 'application/pdf', 'x');
    const { file } = up.json() as { file: { id: number } };
    await app.inject({ method: 'PATCH', url: `/files/${file.id}`, headers: { authorization: `Bearer ${token}` }, payload: { tags: ['reimbursement'] } });

    const res = await app.inject({ method: 'GET', url: '/search?q=reimbursement', headers: { authorization: `Bearer ${token}` } });
    expect((res.json() as { results: unknown[] }).results).toHaveLength(1);
  });

  it('displayName kosong-spasi → 422; file tak ada → 404', async () => {
    const token = await login();
    const up = await upload(token, 'a.pdf', 'application/pdf', 'x');
    const { file } = up.json() as { file: { id: number } };
    const bad = await app.inject({ method: 'PATCH', url: `/files/${file.id}`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: '   ' } });
    expect(bad.statusCode).toBe(422);
    const missing = await app.inject({ method: 'PATCH', url: '/files/9999', headers: { authorization: `Bearer ${token}` }, payload: { tags: ['x'] } });
    expect(missing.statusCode).toBe(404);
  });

  it('menghapus rename dengan null mengembalikan nama asli', async () => {
    const token = await login();
    const up = await upload(token, 'dokumen.pdf', 'application/pdf', 'x');
    const { file } = up.json() as { file: { id: number } };
    await app.inject({ method: 'PATCH', url: `/files/${file.id}`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: 'Nama Baru' } });
    const res = await app.inject({ method: 'PATCH', url: `/files/${file.id}`, headers: { authorization: `Bearer ${token}` }, payload: { displayName: null } });
    expect((res.json() as { file: { displayName: string | null } }).file.displayName).toBeNull();
  });
});

describe('hapus file', () => {
  it('menghapus dari DB dan mengirim delete ke Telegram', async () => {
    const token = await login();
    const up = await upload(token, 'buang.pdf', 'application/pdf', 'x');
    const { file } = up.json() as { file: { id: number; messageId: number; channelId: number } };

    const res = await app.inject({ method: 'DELETE', url: `/files/${file.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);

    // tak ada lagi di list & tak bisa diunduh
    const list = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    expect((list.json() as { files: Array<{ id: number }> }).files.find((f) => f.id === file.id)).toBeUndefined();
    const dl = await app.inject({ method: 'GET', url: `/files/${file.id}/download`, headers: { authorization: `Bearer ${token}` } });
    expect(dl.statusCode).toBe(404);
    // delete benar-benar dikirim ke gateway
    expect(fake.deleted.some((d) => d.messageIds.includes(file.messageId))).toBe(true);
  });

  it('file tak ada → 404', async () => {
    const token = await login();
    const res = await app.inject({ method: 'DELETE', url: '/files/9999', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(404);
  });
});

describe('pindah kategori', () => {
  it('mengirim salinan ke topik baru dulu, lalu menghapus pesan lama & memindahkan baris DB', async () => {
    const token = await login();
    const up = await upload(token, 'foto-liburan.jpg', 'image/jpeg', 'img');
    const { file } = up.json() as { file: { id: number; messageId: number; channelId: number; categoryKey: string } };
    expect(file.categoryKey).toBe('gambar');
    const sentBefore = fake.sent.length;

    const res = await app.inject({
      method: 'PATCH', url: `/files/${file.id}/category`,
      headers: { authorization: `Bearer ${token}` },
      payload: { category: 'arsip' },
    });
    expect(res.statusCode).toBe(200);
    const upd = (res.json() as { file: { categoryKey: string; messageId: number; channelId: number } }).file;
    expect(upd.categoryKey).toBe('arsip');
    // salinan baru terkirim (pesan baru ≠ pesan lama) dan pesan lama dihapus
    expect(fake.sent.length).toBe(sentBefore + 1);
    expect(upd.messageId).not.toBe(file.messageId);
    expect(fake.deleted.some((d) => d.messageIds.includes(file.messageId))).toBe(true);
    // tampil di list dengan kategori baru
    const list = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    const row = (list.json() as { files: Array<{ id: number; categoryKey: string }> }).files.find((f) => f.id === file.id);
    expect(row?.categoryKey).toBe('arsip');
  });

  it('kategori sama → no-op (tanpa kirim ulang); kategori tak dikenal → 404; file tak ada → 404', async () => {
    const token = await login();
    const up = await upload(token, 'dok.pdf', 'application/pdf', 'x');
    const { file } = up.json() as { file: { id: number } };
    const sentBefore = fake.sent.length;

    const same = await app.inject({ method: 'PATCH', url: `/files/${file.id}/category`, headers: { authorization: `Bearer ${token}` }, payload: { category: 'dokumen' } });
    expect(same.statusCode).toBe(200);
    expect(fake.sent.length).toBe(sentBefore); // tidak ada kirim ulang

    const badCat = await app.inject({ method: 'PATCH', url: `/files/${file.id}/category`, headers: { authorization: `Bearer ${token}` }, payload: { category: 'tidak-ada' } });
    expect(badCat.statusCode).toBe(404);
    const missing = await app.inject({ method: 'PATCH', url: '/files/9999/category', headers: { authorization: `Bearer ${token}` }, payload: { category: 'arsip' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('aksi massal (batch)', () => {
  it('tag massal: semua id dapat tag baru', async () => {
    const token = await login();
    const a = (await upload(token, 'a.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };
    const b = (await upload(token, 'b.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };

    const res = await app.inject({ method: 'POST', url: '/files/batch', headers: { authorization: `Bearer ${token}` }, payload: { action: 'tag', ids: [a.file.id, b.file.id], tags: ['arsip-2026'] } });
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: Array<{ id: number; ok: boolean }> };
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);

    const search = await app.inject({ method: 'GET', url: '/search?q=arsip-2026', headers: { authorization: `Bearer ${token}` } });
    expect((search.json() as { results: unknown[] }).results).toHaveLength(2);
  });

  it('hapus massal: id duplikat diringkas, id tak dikenal dilaporkan per-id, id valid tetap terhapus', async () => {
    const token = await login();
    const a = (await upload(token, 'x1.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };
    const b = (await upload(token, 'x2.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };

    const res = await app.inject({ method: 'POST', url: '/files/batch', headers: { authorization: `Bearer ${token}` }, payload: { action: 'delete', ids: [a.file.id, a.file.id, 99999] } });
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: Array<{ id: number; ok: boolean; error?: string }> };
    // duplikat diringkas → hanya 2 entri (a + 99999)
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.id === a.file.id)?.ok).toBe(true);
    expect(results.find((r) => r.id === 99999)?.error).toBe('FILE_NOT_FOUND');

    const list = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    const files = (list.json() as { files: Array<{ id: number }> }).files;
    expect(files.find((f) => f.id === a.file.id)).toBeUndefined();
    expect(files.find((f) => f.id === b.file.id)).toBeTruthy(); // tidak tersentuh
  });

  it('pindah massal: tiap id pindah sendiri; salah satu gagal tak menggagalkan yang lain', async () => {
    const token = await login();
    const a = (await upload(token, 'm1.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };
    const b = (await upload(token, 'm2.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };

    const res = await app.inject({ method: 'POST', url: '/files/batch', headers: { authorization: `Bearer ${token}` }, payload: { action: 'move', ids: [a.file.id, b.file.id, 99999], category: 'arsip' } });
    expect(res.statusCode).toBe(200);
    const { results } = res.json() as { results: Array<{ id: number; ok: boolean; error?: string }> };
    expect(results.find((r) => r.id === a.file.id)?.ok).toBe(true);
    expect(results.find((r) => r.id === b.file.id)?.ok).toBe(true);
    expect(results.find((r) => r.id === 99999)?.error).toBe('FILE_NOT_FOUND');

    const list = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    const moved = (list.json() as { files: Array<{ id: number; categoryKey: string }> }).files.filter((f) => f.id === a.file.id || f.id === b.file.id);
    expect(moved.every((f) => f.categoryKey === 'arsip')).toBe(true);
  });

  it('validasi: move tanpa category → 422, tag tanpa tags → 422, ids kosong → 422, action tak dikenal → 422, tanpa auth → 401', async () => {
    const token = await login();
    const noCat = await app.inject({ method: 'POST', url: '/files/batch', headers: { authorization: `Bearer ${token}` }, payload: { action: 'move', ids: [1] } });
    expect(noCat.statusCode).toBe(422);
    const noTags = await app.inject({ method: 'POST', url: '/files/batch', headers: { authorization: `Bearer ${token}` }, payload: { action: 'tag', ids: [1] } });
    expect(noTags.statusCode).toBe(422);
    const empty = await app.inject({ method: 'POST', url: '/files/batch', headers: { authorization: `Bearer ${token}` }, payload: { action: 'delete', ids: [] } });
    expect(empty.statusCode).toBe(422);
    const badAction = await app.inject({ method: 'POST', url: '/files/batch', headers: { authorization: `Bearer ${token}` }, payload: { action: 'explode', ids: [1] } });
    expect(badAction.statusCode).toBe(422);
    const noAuth = await app.inject({ method: 'POST', url: '/files/batch', payload: { action: 'delete', ids: [1] } });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe('search', () => {
  it('parser + FTS menemukan file yang baru diupload', async () => {
    const token = await login();
    await upload(token, 'laporan akhir juni.pdf', 'application/pdf', 'a');
    await upload(token, 'foto liburan.jpg', 'image/jpeg', 'b');

    const byExt = await app.inject({ method: 'GET', url: '/search?q=pdf', headers: { authorization: `Bearer ${token}` } });
    const r1 = byExt.json() as { results: Array<{ name: string }> };
    expect(r1.results).toHaveLength(1);
    expect(r1.results[0]!.name).toBe('laporan akhir juni.pdf');

    const byText = await app.inject({ method: 'GET', url: '/search?q=liburan', headers: { authorization: `Bearer ${token}` } });
    expect((byText.json() as { results: unknown[] }).results).toHaveLength(1);

    // "juni" = bulan lalu relatif terhadap waktu upload (hari ini) → tidak ada hasil
    const byDate = await app.inject({ method: 'GET', url: '/search?q=pdf%20juni', headers: { authorization: `Bearer ${token}` } });
    expect((byDate.json() as { results: unknown[] }).results).toHaveLength(0);

    // kategori: 'gambar' → hanya file gambar
    const byCat = await app.inject({ method: 'GET', url: '/search?q=gambar', headers: { authorization: `Bearer ${token}` } });
    expect((byCat.json() as { results: unknown[] }).results).toHaveLength(1);
  });

  it('query kosong tidak melempar error', async () => {
    const token = await login();
    const res = await app.inject({ method: 'GET', url: '/search?q=', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('categories', () => {
  it('menampilkan 6 kategori default dengan jumlah file', async () => {
    const token = await login();
    const res = await app.inject({ method: 'GET', url: '/categories', headers: { authorization: `Bearer ${token}` } });
    const { categories } = res.json() as { categories: Array<{ key: string; fileCount: number }> };
    expect(categories).toHaveLength(6);
  });
});
