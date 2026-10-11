import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import type { TelegramGateway, ChannelInfo, MeInfo, SentFileResult } from '../telegram.js';

const KEY = '1'.repeat(64);

class FakeGateway implements TelegramGateway {
  channels = new Map<string, ChannelInfo>();
  sent: Array<{ channelId: number; filePath: string; caption: string }> = [];
  requireTwoFa = false;
  private msgId = 100;

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
  async ensureCategoryChannel(title: string): Promise<ChannelInfo> {
    const existing = this.channels.get(title);
    if (existing) return existing;
    const info = { channelId: -100000 - this.channels.size, title };
    this.channels.set(title, info);
    return info;
  }
  async sendFileToChannel(channelId: number, filePath: string, caption: string): Promise<SentFileResult> {
    this.sent.push({ channelId, filePath, caption });
    return { messageId: this.msgId++, channelId };
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

describe('upload pipeline', () => {
  it('mengklasifikasi, membuat channel kategori, mencatat, dan mengantre sinkron', async () => {
    const token = await login();
    const res = await upload(token, 'laporan.pdf', 'application/pdf', 'isi-pdf');
    expect(res.statusCode).toBe(200);
    const { file } = res.json() as { file: { categoryKey: string; name: string; ext: string; messageId: number } };
    expect(file.categoryKey).toBe('dokumen');
    expect(file.ext).toBe('pdf');
    expect(fake.channels.has('Drive · Dokumen')).toBe(true);

    const status = await app.inject({ method: 'GET', url: '/sync/status', headers: { authorization: `Bearer ${token}` } });
    expect((status.json() as { pending: number }).pending).toBe(1);
  });

  it('reuse channel kategori yang sudah ada (tidak dobel buat)', async () => {
    const token = await login();
    await upload(token, 'a.jpg', 'image/jpeg', 'x');
    await upload(token, 'b.jpg', 'image/jpeg', 'y');
    expect(fake.channels.size).toBe(1);
    expect(fake.channels.has('Drive · Gambar')).toBe(true);
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
