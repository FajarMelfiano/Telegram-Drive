import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { TelegramGateway, DriveGroupInfo, TopicInfo, MeInfo, SentFileResult } from '../telegram.js';
import type { WaGateway, WaMessageFile, WaStatus } from '../whatsapp.js';

const KEY = '1'.repeat(64);

/** Fake gateway WhatsApp: kontrol penuh tanpa jaringan (state + injeksi file). */
class FakeWaGateway implements WaGateway {
  state: WaStatus['state'] = 'disconnected';
  qr: string | null = null;
  phone: string | null = null;
  lastError: string | null = null;
  connectCalls = 0;
  disconnectCalls = 0;
  private fileHandlers: Array<(f: WaMessageFile) => void> = [];
  private statusHandlers: Array<(s: WaStatus) => void> = [];

  async connect(): Promise<void> {
    this.connectCalls++;
    this.state = this.qr ? 'qr_ready' : 'linked';
    this.phone = this.state === 'linked' ? '628111' : null;
    this.emit();
  }
  async disconnect(): Promise<void> {
    this.disconnectCalls++;
    this.state = 'disconnected'; this.qr = null; this.phone = null;
    this.emit();
  }
  status(): WaStatus {
    return { state: this.state, qr: this.qr, phone: this.phone, lastError: this.lastError };
  }
  getQr(): string | null { return this.state === 'qr_ready' ? this.qr : null; }
  onFile(h: (f: WaMessageFile) => void): void { this.fileHandlers.push(h); }
  onStatus(h: (s: WaStatus) => void): void { this.statusHandlers.push(h); }
  destroy(): void { this.fileHandlers = []; this.statusHandlers = []; }

  /** Suntikkan seolah-olah satu file tiba dari direct chat WA. */
  emitFile(f: WaMessageFile): void { for (const h of this.fileHandlers) h(f); }
  private emit(): void { const s = this.status(); for (const h of this.statusHandlers) h(s); }
}

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

let fakeWa: FakeWaGateway;

beforeEach(async () => {
  fake = new FakeGateway(1, 'hash-abc');
  fakeWa = new FakeWaGateway();
  app = buildApp({
    config: { TURNO_SECRET_KEY: KEY, MAX_FILE_BYTES: 10_000_000 },
    gatewayFactory: async (id, hash, session) => { fake.apiId = id; fake.apiHash = hash; fake.session = session; return fake; },
    waGatewayFactory: () => fakeWa,
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
  it('alur penuh: web buat kode (tanpa login) → HP setujui → web poll approved → web claim → dapat token + cookie', async () => {
    const { token: hpToken } = await loginFull(); // HP yang sudah login

    // 1. WEB membuat kode pairing TANPA login (kode inilah yang digambar jadi QR)
    const created = await app.inject({ method: 'POST', url: '/auth/pairing', payload: { deviceLabel: 'Chrome Linux' } });
    expect(created.statusCode).toBe(200);
    const { code, expiresIn } = created.json() as { code: string; expiresIn: number };
    expect(code).toBeTruthy();
    expect(expiresIn).toBe(300);

    // 2. Web poll → pending (belum disetujui)
    const poll1 = await app.inject({ method: 'GET', url: `/auth/pairing/${code}` });
    expect(poll1.statusCode).toBe(200);
    expect((poll1.json() as { status: string }).status).toBe('pending');

    // 3. Web claim SEBELUM approve → ditolak 409 (belum disetujui HP)
    const early = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/claim` });
    expect(early.statusCode).toBe(409);

    // 4. HP menyetujui kode hasil pindaian
    const approve = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/approve`, headers: { authorization: `Bearer ${hpToken}` } });
    expect(approve.statusCode).toBe(200);

    // approve kedua ditolak (single-use)
    const approve2 = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/approve`, headers: { authorization: `Bearer ${hpToken}` } });
    expect(approve2.statusCode).toBe(410);

    // 5. Web poll → approved
    const poll2 = await app.inject({ method: 'GET', url: `/auth/pairing/${code}` });
    expect((poll2.json() as { status: string }).status).toBe('approved');

    // 6. Web tukar kode → token + cookie httpOnly
    const claim = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/claim` });
    expect(claim.statusCode).toBe(200);
    const body = claim.json() as { token: string; refreshToken: string };
    expect(body.token).toBeTruthy();
    const setCookie = claim.headers['set-cookie'] as string[] | string | undefined;
    const cookies = Array.isArray(setCookie) ? setCookie : [String(setCookie ?? '')];
    expect(cookies.some((c) => c.startsWith('td_refresh=') && c.includes('HttpOnly'))).toBe(true);

    // 7. token klaim valid → /me sukses
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${body.token}` } });
    expect(me.statusCode).toBe(200);

    // 8. claim kedua ditolak (single-use redeemed)
    const again = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/claim` });
    expect(again.statusCode).toBe(410);
  });

  it('kode tidak dikenal → 404 di poll, approve & claim', async () => {
    const { token } = await loginFull();
    const poll = await app.inject({ method: 'GET', url: '/auth/pairing/deadbeef' });
    expect(poll.statusCode).toBe(404);
    const approve = await app.inject({ method: 'POST', url: '/auth/pairing/deadbeef/approve', headers: { authorization: `Bearer ${token}` } });
    expect(approve.statusCode).toBe(404);
    const claim = await app.inject({ method: 'POST', url: '/auth/pairing/deadbeef/claim' });
    expect(claim.statusCode).toBe(404);
  });

  it('kode kedaluwarsa → 410 di poll, approve & claim', async () => {
    await loginFull();
    const created = await app.inject({ method: 'POST', url: '/auth/pairing', payload: {} });
    const { code } = created.json() as { code: string };
    // Paksa kedaluwarsa langsung di DB
    app.db.prepare('UPDATE pairing_codes SET expires_at = ? WHERE code = ?').run(new Date(Date.now() - 1000).toISOString(), code);
    const poll = await app.inject({ method: 'GET', url: `/auth/pairing/${code}` });
    expect(poll.statusCode).toBe(410);
    const claim = await app.inject({ method: 'POST', url: `/auth/pairing/${code}/claim` });
    expect(claim.statusCode).toBe(410);
  });

  it('approve butuh login HP (tanpa token → 401); membuat kode TANPA login diperbolehkan (web)', async () => {
    // approve tanpa login → 401
    const approveNoAuth = await app.inject({ method: 'POST', url: '/auth/pairing/abcdef/approve' });
    expect(approveNoAuth.statusCode).toBe(401);
    // membuat kode tanpa login → 200 (web yang belum masuk)
    const created = await app.inject({ method: 'POST', url: '/auth/pairing', payload: {} });
    expect(created.statusCode).toBe(200);
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

describe('zip massal', () => {
  it('menghasilkan arsip ZIP valid berisi file yang diminta (nama unicode aman)', async () => {
    const token = await login();
    const a = (await upload(token, 'laporan.pdf', 'application/pdf', 'isi-pdf-1')).json() as { file: { id: number; messageId: number } };
    const b = (await upload(token, 'foto 🌴.jpg', 'image/jpeg', 'isi-jpg-2')).json() as { file: { id: number; messageId: number } };

    const res = await app.inject({ method: 'GET', url: `/files/zip?ids=${a.file.id},${b.file.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(String(res.headers['content-disposition'])).toContain('attachment');

    const buf = res.rawPayload;
    // signature lokal "PK\x03\x04" di awal & EOCD "PK\x05\x06" di akhir
    expect(buf.subarray(0, 4).toString('latin1')).toBe('PK\u0003\u0004');
    expect(buf.subarray(buf.length - 22, buf.length - 18).toString('latin1')).toBe('PK\u0005\u0006');
    // isi file terkunci di dalam (STORE → plaintext; FakeGateway menulis ISI-REMOTE-<msgId>)
    expect(buf.toString('latin1')).toContain(`ISI-REMOTE-${a.file.messageId}`);
    expect(buf.toString('latin1')).toContain(`ISI-REMOTE-${b.file.messageId}`);
    // EOCD: jumlah entri = 2
    expect(buf.readUInt16LE(buf.length - 12)).toBe(2);
    // nama unicode ter-encode UTF-8 penuh
    expect(buf.toString('utf8')).toContain('foto 🌴.jpg');
  });

  it('nama duplikat dalam satu zip diringkas " (2)"; id tak dikenal dilewati', async () => {
    const token = await login();
    const a = (await upload(token, 'sama.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };
    const b = (await upload(token, 'sama.pdf', 'application/pdf', 'y')).json() as { file: { id: number } };

    const res = await app.inject({ method: 'GET', url: `/files/zip?ids=${a.file.id},${b.file.id},99999`, headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const text = res.rawPayload.toString('utf8');
    expect(text).toContain('sama.pdf');
    expect(text).toContain('sama (2).pdf');
    expect(res.rawPayload.readUInt16LE(res.rawPayload.length - 12)).toBe(2); // 99999 dilewati
  });

  it('semua id tak dikenal → 404; ids kosong → 422; >20 id → 422; tanpa auth → 401', async () => {
    const token = await login();
    const none = await app.inject({ method: 'GET', url: '/files/zip?ids=99998,99999', headers: { authorization: `Bearer ${token}` } });
    expect(none.statusCode).toBe(404);
    const empty = await app.inject({ method: 'GET', url: '/files/zip?ids=', headers: { authorization: `Bearer ${token}` } });
    expect(empty.statusCode).toBe(422);
    const many = await app.inject({ method: 'GET', url: `/files/zip?ids=${Array.from({ length: 21 }, (_, i) => i + 1).join(',')}`, headers: { authorization: `Bearer ${token}` } });
    expect(many.statusCode).toBe(422);
    const noAuth = await app.inject({ method: 'GET', url: '/files/zip?ids=1' });
    expect(noAuth.statusCode).toBe(401);
  });
});

describe('statistik penyimpanan', () => {
  it('menghitung total, per kategori, per ekstensi, dan per sumber', async () => {
    const token = await login();
    await upload(token, 'laporan.pdf', 'application/pdf', 'x');
    await upload(token, 'foto.jpg', 'image/jpeg', 'x');
    await upload(token, 'foto2.jpg', 'image/jpeg', 'x');

    const res = await app.inject({ method: 'GET', url: '/stats', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as {
      totalFiles: number; totalBytes: number;
      byCategory: Array<{ key: string; count: number; bytes: number }>;
      byExt: Array<{ ext: string; count: number }>;
      bySource: Array<{ source: string; count: number }>;
    };
    expect(stats.totalFiles).toBe(3);
    expect(stats.totalBytes).toBe(3); // 3 file 'x' 1 byte... cek aktual
    const dokumen = stats.byCategory.find((c) => c.key === 'dokumen');
    expect(dokumen?.count).toBe(1);
    const gambar = stats.byCategory.find((c) => c.key === 'gambar');
    expect(gambar?.count).toBe(2);
    expect(stats.byExt.find((e) => e.ext === 'jpg')?.count).toBe(2);
    expect(stats.bySource.find((s) => s.source === 'telegram')?.count).toBe(3);
  });
});

describe('riwayat aktivitas', () => {
  it('mencatat upload lalu bisa dibaca (terbaru dulu)', async () => {
    const token = await login();
    const up = await upload(token, 'aktivitas.pdf', 'application/pdf', 'x');
    const { file } = up.json() as { file: { id: number } };
    await app.inject({ method: 'PATCH', url: `/files/${file.id}`, headers: { authorization: `Bearer ${token}` }, payload: { tags: ['baruu'] } });

    const res = await app.inject({ method: 'GET', url: '/activity?limit=10', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const { activity } = res.json() as { activity: Array<{ type: string; detail: { id?: number } }> };
    expect(activity.length).toBeGreaterThanOrEqual(2);
    // terbaru dulu: file.updated di atas file.uploaded
    const updIdx = activity.findIndex((a) => a.type === 'file.updated');
    const upIdx = activity.findIndex((a) => a.type === 'file.uploaded');
    expect(updIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThanOrEqual(0);
    expect(updIdx).toBeLessThan(upIdx);
    expect(activity[updIdx]?.detail.id).toBe(file.id);
  });

  it('membatasi jumlah sesuai limit', async () => {
    const token = await login();
    await upload(token, 'a.pdf', 'application/pdf', 'x');
    const res = await app.inject({ method: 'GET', url: '/activity?limit=1', headers: { authorization: `Bearer ${token}` } });
    expect((res.json() as { activity: unknown[] }).activity).toHaveLength(1);
  });
});

describe('SSE /events', () => {
  it('menolak tanpa token (401)', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/events' });
    expect(noAuth.statusCode).toBe(401);
  });

  it('menerima ?token= dan stream event realtime saat file diunggah', async () => {
    const token = await login();
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ac = new AbortController();
    try {
      const res = await fetch(`${address}/events?token=${token}`, { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      // baca stream di background, kumpulkan potongan yang masuk
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      const pump = (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
          }
        } catch { /* abort diakhiri test */ }
      })();

      // beri waktu koneksi terbentuk, lalu unggah file → harus mem-broadcast file.uploaded
      await new Promise((r) => setTimeout(r, 100));
      const mp = multipart('live.pdf', 'application/pdf', 'isi-live');
      const up = await fetch(`${address}/files`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, ...mp.headers },
        body: mp.payload,
      });
      expect(up.status).toBe(200);

      // tunggu event file.uploaded tiba di stream
      const deadline = Date.now() + 3000;
      while (!buf.includes('event: file.uploaded') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(buf).toContain('event: file.uploaded');
    } finally {
      ac.abort();
    }
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

describe('integrasi WhatsApp', () => {
  it('/wa/status awal disconnected; butuh auth (401 tanpa token)', async () => {
    const noAuth = await app.inject({ method: 'GET', url: '/wa/status' });
    expect(noAuth.statusCode).toBe(401);
    const token = await login();
    const res = await app.inject({ method: 'GET', url: '/wa/status', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { state: string }).state).toBe('disconnected');
  });

  it('/wa/connect memanggil gateway lalu /wa/disconnect mengembalikan disconnected', async () => {
    const token = await login();
    const conn = await app.inject({ method: 'POST', url: '/wa/connect', headers: { authorization: `Bearer ${token}` } });
    expect(conn.statusCode).toBe(200);
    expect(fakeWa.connectCalls).toBe(1);
    expect((conn.json() as { state: string }).state).toBe('linked');

    // idempoten: panggil lagi tidak error
    await app.inject({ method: 'POST', url: '/wa/connect', headers: { authorization: `Bearer ${token}` } });
    expect(fakeWa.connectCalls).toBe(2);

    const dis = await app.inject({ method: 'POST', url: '/wa/disconnect', headers: { authorization: `Bearer ${token}` } });
    expect(dis.statusCode).toBe(200);
    expect(fakeWa.disconnectCalls).toBe(1);
    expect((dis.json() as { state: string }).state).toBe('disconnected');
  });

  it('file dari direct chat WA → terkirim ke topik kategori sesuai mime & tercatat source=whatsapp', async () => {
    const token = await login();
    // pastikan gateway Telegram sudah login (agar handleWaFile punya cachedGateway)
    await login();
    fakeWa.emitFile({
      chatJid: '628123@s.whatsapp.net', msgId: 'WA-1',
      name: 'faktur.pdf', mime: 'application/pdf', size: 4,
      data: Buffer.from('fakt'), timestamp: 1790000000,
    });
    // beri waktu handler async selesai
    await new Promise((r) => setTimeout(r, 150));

    const list = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    const files = (list.json() as { files: Array<{ name: string; source: string; categoryKey: string; chatJid: string | null }> }).files;
    const row = files.find((f) => f.name === 'faktur.pdf');
    expect(row).toBeTruthy();
    expect(row?.source).toBe('whatsapp');
    expect(row?.categoryKey).toBe('dokumen');
    expect(row?.chatJid).toBe('628123@s.whatsapp.net');
    // terkirim juga ke gateway Telegram (topik dokumen)
    expect(fake.sent.some((s) => s.caption === 'faktur.pdf')).toBe(true);
  });

  it('dedup: msgId sama dari chat sama hanya diproses sekali', async () => {
    const token = await login();
    const mk = (): WaMessageFile => ({
      chatJid: '628999@s.whatsapp.net', msgId: 'DUP-1',
      name: 'duplikat.jpg', mime: 'image/jpeg', size: 3,
      data: Buffer.from('img'), timestamp: 1790000000,
    });
    fakeWa.emitFile(mk());
    await new Promise((r) => setTimeout(r, 150));
    fakeWa.emitFile(mk()); // upsert ulang dari Baileys
    await new Promise((r) => setTimeout(r, 150));

    const list = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    const hits = (list.json() as { files: Array<{ name: string }> }).files.filter((f) => f.name === 'duplikat.jpg');
    expect(hits).toHaveLength(1);
  });

  it('file terlalu besar → dilewati dengan activity wa.skipped', async () => {
    const token = await login();
    fakeWa.emitFile({
      chatJid: '628777@s.whatsapp.net', msgId: 'BIG-1',
      name: 'gede.zip', mime: 'application/zip', size: 999_999_999,
      data: Buffer.alloc(10), timestamp: 1790000000,
    });
    await new Promise((r) => setTimeout(r, 150));
    const list = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    expect((list.json() as { files: Array<{ name: string }> }).files.find((f) => f.name === 'gede.zip')).toBeUndefined();

    const act = await app.inject({ method: 'GET', url: '/activity', headers: { authorization: `Bearer ${token}` } });
    const types = (act.json() as { activity: Array<{ type: string }> }).activity.map((a) => a.type);
    expect(types).toContain('wa.skipped');
  });

  it('belum login Telegram → file WA dilewati (NOT_LOGGED_IN), tak crash', async () => {
    // tanpa login Telegram dulu: cachedGateway null
    fakeWa.emitFile({
      chatJid: '628555@s.whatsapp.net', msgId: 'NL-1',
      name: 'tanpa-login.pdf', mime: 'application/pdf', size: 3,
      data: Buffer.from('abc'), timestamp: 1790000000,
    });
    await new Promise((r) => setTimeout(r, 150));
    const token = await login();
    const act = await app.inject({ method: 'GET', url: '/activity', headers: { authorization: `Bearer ${token}` } });
    const skipped = (act.json() as { activity: Array<{ type: string; detail: { reason?: string } }> }).activity
      .find((a) => a.type === 'wa.skipped');
    expect(skipped?.detail.reason).toBe('NOT_LOGGED_IN');
  });

  it('file WA muncul di pencarian (FTS) dengan sumber whatsapp', async () => {
    const token = await login();
    fakeWa.emitFile({
      chatJid: '628444@s.whatsapp.net', msgId: 'S-1',
      name: 'kwitansi-warung.pdf', mime: 'application/pdf', size: 3,
      data: Buffer.from('kwi'), timestamp: 1790000000,
    });
    await new Promise((r) => setTimeout(r, 150));
    const res = await app.inject({ method: 'GET', url: '/search?q=kwitansi', headers: { authorization: `Bearer ${token}` } });
    const results = (res.json() as { results: Array<{ name: string; source: string }> }).results;
    expect(results.some((r) => r.name === 'kwitansi-warung.pdf' && r.source === 'whatsapp')).toBe(true);
  });
});

describe('album (koleksi manual)', () => {
  it('alur penuh: buat → tambah file → daftar file → rename → hapus album (file tetap di gudang)', async () => {
    const token = await login();
    const a = (await upload(token, 'a.pdf', 'application/pdf', 'x')).json() as { file: { id: number } };
    const b = (await upload(token, 'b.jpg', 'image/jpeg', 'x')).json() as { file: { id: number } };

    // buat
    const created = await app.inject({ method: 'POST', url: '/albums', headers: { authorization: `Bearer ${token}` }, payload: { name: 'Liburan 2026' } });
    expect(created.statusCode).toBe(200);
    const { album } = created.json() as { album: { id: number; name: string; fileCount: number } };
    expect(album.name).toBe('Liburan 2026');
    expect(album.fileCount).toBe(0);

    // tambah dua file
    const add = await app.inject({ method: 'POST', url: `/albums/${album.id}/files`, headers: { authorization: `Bearer ${token}` }, payload: { fileIds: [a.file.id, b.file.id] } });
    expect(add.statusCode).toBe(200);
    expect((add.json() as { added: number }).added).toBe(2);

    // idempoten: tambah lagi → added 0
    const again = await app.inject({ method: 'POST', url: `/albums/${album.id}/files`, headers: { authorization: `Bearer ${token}` }, payload: { fileIds: [a.file.id] } });
    expect((again.json() as { added: number }).added).toBe(0);

    // daftar file terurut
    const listF = await app.inject({ method: 'GET', url: `/albums/${album.id}/files`, headers: { authorization: `Bearer ${token}` } });
    const files = (listF.json() as { files: Array<{ id: number }> }).files;
    expect(files.map((f) => f.id)).toEqual([a.file.id, b.file.id]);

    // rename
    const ren = await app.inject({ method: 'PATCH', url: `/albums/${album.id}`, headers: { authorization: `Bearer ${token}` }, payload: { name: 'Renamed' } });
    expect((ren.json() as { album: { name: string } }).album.name).toBe('Renamed');

    // daftar album memuat album + fileCount 2
    const listA = await app.inject({ method: 'GET', url: '/albums', headers: { authorization: `Bearer ${token}` } });
    const albums = (listA.json() as { albums: Array<{ id: number; fileCount: number }> }).albums;
    expect(albums.find((x) => x.id === album.id)?.fileCount).toBe(2);

    // keluarkan satu file
    const rm = await app.inject({ method: 'DELETE', url: `/albums/${album.id}/files/${b.file.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(rm.statusCode).toBe(200);

    // hapus album
    const del = await app.inject({ method: 'DELETE', url: `/albums/${album.id}`, headers: { authorization: `Bearer ${token}` } });
    expect(del.statusCode).toBe(200);

    // file ASLI masih ada di gudang (hapus album ≠ hapus file)
    const manifest = await app.inject({ method: 'GET', url: '/files', headers: { authorization: `Bearer ${token}` } });
    const all = (manifest.json() as { files: Array<{ id: number }> }).files;
    expect(all.find((f) => f.id === a.file.id)).toBeTruthy();
    expect(all.find((f) => f.id === b.file.id)).toBeTruthy();
  });

  it('validasi & 404: nama kosong → 422; album tak ada → 404; fileId tak dikenal diabaikan; tanpa auth → 401', async () => {
    const token = await login();
    const noName = await app.inject({ method: 'POST', url: '/albums', headers: { authorization: `Bearer ${token}` }, payload: { name: '   ' } });
    expect(noName.statusCode).toBe(422);

    const missing = await app.inject({ method: 'GET', url: '/albums/9999', headers: { authorization: `Bearer ${token}` } });
    expect(missing.statusCode).toBe(404);
    const missingFiles = await app.inject({ method: 'GET', url: '/albums/9999/files', headers: { authorization: `Bearer ${token}` } });
    expect(missingFiles.statusCode).toBe(404);

    // album valid, tapi file id tak ada → added 0 (difilter)
    const created = await app.inject({ method: 'POST', url: '/albums', headers: { authorization: `Bearer ${token}` }, payload: { name: 'X' } });
    const { album } = created.json() as { album: { id: number } };
    const add = await app.inject({ method: 'POST', url: `/albums/${album.id}/files`, headers: { authorization: `Bearer ${token}` }, payload: { fileIds: [99998, 99999] } });
    expect(add.statusCode).toBe(200);
    expect((add.json() as { added: number }).added).toBe(0);

    const rmMissing = await app.inject({ method: 'DELETE', url: `/albums/${album.id}/files/99999`, headers: { authorization: `Bearer ${token}` } });
    expect(rmMissing.statusCode).toBe(404);

    const noAuth = await app.inject({ method: 'GET', url: '/albums' });
    expect(noAuth.statusCode).toBe(401);
  });
});
