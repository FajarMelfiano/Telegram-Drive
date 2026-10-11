import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { encrypt, decrypt } from './crypto.js';

/**
 * Gateway WhatsApp via Baileys (linked-device protocol).
 *
 * Arsitektur: satu socket Baileys yang menempel sebagai "perangkat tertaut"
 * (setara WhatsApp Web). Status & QR di-expose ke app; pesan direct chat
 * yang berisi media di-klasifikasi lalu diteruskan ke handler (di app.ts)
 * untuk dikirim ke topik kategori Telegram.
 *
 * Keputusan desain:
 * - Kontrak `WaGateway` dipisah dari implementasi Baileys → bisa diuji dengan
 *   fake tanpa jaringan (sama seperti TelegramGateway).
 * - Auth state disimpan sebagai JSON terenkripsi AES-GCM di path data
 *   (bukan multi-file mentah) → satu berkas, aman at-rest.
 * - State machine: disconnected → connecting → qr_ready → linked
 *   → reconnecting | failed. Transisi dijalankan oleh event `connection.update`.
 * - Auto-reconnect dengan backoff eksponensial (5s → 60maks), kecuali
 *   `loggedOut` (perlu scan ulang oleh user) yang berhenti di `disconnected`.
 */

export type WaState =
  | 'disconnected'   // belum tersambung / sudah dicabut
  | 'connecting'     // sedang membuka socket
  | 'qr_ready'       // QR tersedia, menunggu discan dari HP
  | 'linked'         // tersambung, siap menerima pesan
  | 'reconnecting'   // koneksi putus, sedang mencoba lagi
  | 'failed';        // gagal permanen (butuh tindakan user)

export interface WaMessageFile {
  /** JID chat pengirim (mis. '628xxx@s.whatsapp.net'). */
  chatJid: string;
  /** ID pesan WhatsApp (untuk dedup). */
  msgId: string;
  /** Nama berkas (document) atau difallback oleh handler. */
  name: string;
  mime: string;
  size: number;
  /** Buffer isi media hasil unduhan Baileys. */
  data: Buffer;
  timestamp: number;
  /** Nama tampilan pengirim (untuk log). */
  senderName?: string;
}

export interface WaStatus {
  state: WaState;
  /** String QR (data URL atau raw) bila state = qr_ready, selain itu null. */
  qr: string | null;
  /** Nomor yang tertaut (bila sudah linked). */
  phone: string | null;
  /** Alasan kegagalan/putus terakhir (untuk ditampilkan). */
  lastError: string | null;
}

/**
 * Kontrak gateway WhatsApp — semua rute memakai interface ini,
 * sehingga bisa diuji dengan fake tanpa jaringan (seperti TelegramGateway).
 */
export interface WaGateway {
  /** Mulai/mulai-ulang koneksi. Aman dipanggil berulang (idempoten). */
  connect(): Promise<void>;
  /** Cabut koneksi & hapus auth state (user harus scan ulang). */
  disconnect(): Promise<void>;
  /** Status saat ini (state + QR + phone). */
  status(): WaStatus;
  /** Dapatkan QR untuk discan (null bila bukan di state qr_ready). */
  getQr(): string | null;
  /** Daftar file yang diterima dari direct chat (stream). */
  onFile(handler: (file: WaMessageFile) => void): void;
  /** Event perubahan status: handler(status). */
  onStatus(handler: (status: WaStatus) => void): void;
  destroy(): void;
}

/** Simpan/ambil/ hapus auth state Baileys (terenkripsi). */
export interface WaAuthStore {
  load(): Promise<Record<string, unknown> | null>;
  save(state: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}

/** Auth store berbasis satu berkas JSON (terenkripsi AES-GCM di tempat lain). */
export class FileWaAuthStore implements WaAuthStore {
  constructor(private readonly path: string) {}
  async load(): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  async save(state: Record<string, unknown>): Promise<void> {
    await writeFile(this.path, JSON.stringify(state), 'utf8');
  }
  async clear(): Promise<void> {
    await rm(this.path, { force: true }).catch(() => undefined);
  }
}

/**
 * Auth store terenkripsi AES-256-GCM (envelope di atas FileWaAuthStore).
 * Kredensial WhatsApp (creds + signal keys) TIDAK boleh tersimpan plaintext
 * di disk — kalaupun bocor, butuh TURNO_SECRET_KEY (64-hex) untuk membuka.
 */
export class EncryptedWaAuthStore implements WaAuthStore {
  private readonly inner: FileWaAuthStore;
  constructor(filePath: string, private readonly hexKey: string) {
    this.inner = new FileWaAuthStore(filePath);
  }
  async load(): Promise<Record<string, unknown> | null> {
    const raw = await this.inner.load();
    if (!raw || typeof raw.payload !== 'string') return null;
    try {
      return JSON.parse(decrypt(raw.payload, this.hexKey)) as Record<string, unknown>;
    } catch {
      return null; // kunci salah / korup → anggap belum login (amankan, jangan crash)
    }
  }
  async save(state: Record<string, unknown>): Promise<void> {
    await this.inner.save({ payload: encrypt(JSON.stringify(state), this.hexKey) });
  }
  async clear(): Promise<void> {
    await this.inner.clear();
  }
}

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * Implementasi Baileys. Impor dinamis `baileys` dilakukan di dalam konstruktor
 * sehingga server tetap bisa boot bila Baileys tidak terpasang (fitur WA off).
 */
export class BaileysWaGateway extends EventEmitter implements WaGateway {
  private state: WaState = 'disconnected';
  private qr: string | null = null;
  private phone: string | null = null;
  private lastError: string | null = null;
  private sock: unknown = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private wantReconnect = false;
  private destroyed = false;
  private fileHandlers: Array<(f: WaMessageFile) => void> = [];
  private statusHandlers: Array<(s: WaStatus) => void> = [];
  private baileys: Record<string, unknown> | null = null;

  constructor(private readonly auth: WaAuthStore) {
    super();
  }

  private async ensureBaileys(): Promise<Record<string, unknown>> {
    if (this.baileys) return this.baileys;
    // Pakai namespace modul penuh, BUKAN `mod.default`. `default` hanya berisi
    // makeWASocket — initAuthCreds/downloadContentFromMessage ada sebagai named
    // export di namespace (via export * from './Utils'). Mengambil mod.default
    // membuat initAuthCreds "not a function" (bug nyata yang ditangkap wa-smoke).
    const mod = (await import('baileys')) as unknown as Record<string, unknown>;
    this.baileys = mod;
    return mod;
  }

  status(): WaStatus {
    return { state: this.state, qr: this.qr, phone: this.phone, lastError: this.lastError };
  }

  getQr(): string | null {
    return this.state === 'qr_ready' ? this.qr : null;
  }

  onFile(handler: (file: WaMessageFile) => void): void {
    this.fileHandlers.push(handler);
  }

  onStatus(handler: (status: WaStatus) => void): void {
    this.statusHandlers.push(handler);
  }

  private setState(next: WaState, opts: Partial<{ qr: string | null; phone: string | null; error: string | null }> = {}): void {
    this.state = next;
    if ('qr' in opts) this.qr = opts.qr ?? null;
    if ('phone' in opts) this.phone = opts.phone ?? null;
    if ('error' in opts) this.lastError = opts.error ?? null;
    const snap = this.status();
    for (const h of this.statusHandlers) {
      try { h(snap); } catch { /* handler pihak ketiga tak boleh merusak gateway */ }
    }
    this.emit('status', snap);
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;
    this.wantReconnect = true;
    this.reconnectAttempt = 0;
    await this.open();
  }

  private async open(): Promise<void> {
    const b = await this.ensureBaileys();
    const makeWASocket = b.makeWASocket as (config: Record<string, unknown>) => Record<string, any>;
    const initAuthCreds = b.initAuthCreds as () => Record<string, unknown>;

    this.setState('connecting', { qr: null, error: null });

    /*
     * Auth state Baileys:
     * - `creds`  = kredensial perangkat (di-init via initAuthCreds bila kosong).
     * - `keys`   = SignalKeyStore BER-METHOD ({ get, set, clear }) — BUKAN objek
     *              data polos. Kalau kita kirim `{}` polos, Baileys gagal baca
     *              pre-keys dan pairing gagal diam-diam.
     *
     * Kita simpan data keys sebagai bucket per tipe (`keyData`) di store
     * terenkripsi, lalu bangun ulang method get/set/clear di atasnya.
     */
    const saved = await this.auth.load();
    const creds = (saved?.creds as Record<string, unknown> | undefined) ?? initAuthCreds();
    const keyData = (saved?.keyData as Record<string, Record<string, unknown>> | undefined) ?? {};

    const persist = (): Promise<void> => this.auth.save({ creds, keyData }).catch(() => undefined);

    const keys = {
      get: async (type: string, ids: string[]) => {
        const bucket = keyData[type] ?? {};
        const out: Record<string, unknown> = {};
        for (const id of ids) if (bucket[id] !== undefined) out[id] = bucket[id];
        return out;
      },
      set: async (data: Record<string, Record<string, unknown> | null>) => {
        for (const [type, entries] of Object.entries(data)) {
          const bucket = { ...(keyData[type] ?? {}) };
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value == null) delete bucket[id]; // null = hapus (SignalDataSet)
            else bucket[id] = value;
          }
          keyData[type] = bucket;
        }
        await persist();
      },
      clear: async () => {
        for (const k of Object.keys(keyData)) delete keyData[k];
        await persist();
      },
    };

    const authState = { creds, keys };

    const sock = makeWASocket({
      auth: authState as never,
      printQRInTerminal: false,
      browser: ['Telegram Drive', 'Chrome', '1.0.0'],
    });
    this.sock = sock;

    // Persist creds setiap berubah (merge ke objek creds yang sama, simpan terenkripsi).
    const saveCreds = (update: Record<string, unknown>) => {
      Object.assign(creds, update);
      void persist();
    };
    if (typeof sock.ev?.on === 'function') {
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('messages.upsert', (ev: unknown) => this.handleMessages(ev));
      sock.ev.on('connection.update', (upd: unknown) => this.handleConnectionUpdate(upd));
    }
  }

  private handleConnectionUpdate(upd: unknown): void {
    const u = upd as { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } };
    if (typeof u.qr === 'string' && u.qr.length > 0) {
      this.setState('qr_ready', { qr: u.qr });
      return;
    }
    if (u.connection === 'open') {
      this.reconnectAttempt = 0;
      const jid = (this.sock as { user?: { id?: string } } | null)?.user?.id;
      this.setState('linked', { qr: null, phone: jid ? jid.split(':')[0] ?? null : null, error: null });
      return;
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      // 401 / loggedOut = perlu scan ulang → berhenti reconnect
      if (code === 401 || code === 440) {
        this.wantReconnect = false;
        void this.auth.clear();
        this.setState('disconnected', { qr: null, phone: null, error: 'SESSION_EXPIRED' });
        return;
      }
      if (!this.wantReconnect || this.destroyed) {
        this.setState('disconnected', { qr: null, error: 'DISCONNECTED' });
        return;
      }
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    this.setState('reconnecting', { qr: null, error: null });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.open().catch((e: unknown) => {
        this.setState('failed', { error: e instanceof Error ? e.message : String(e) });
      });
    }, delay);
  }

  private handleMessages(ev: unknown): void {
    const e = ev as { messages?: unknown[]; type?: string };
    if (e.type && e.type !== 'notify') return; // hanya pesan baru, bukan riwayat
    const messages = Array.isArray(e.messages) ? e.messages : [];
    for (const raw of messages) {
      try {
        // ekstraksi async (unduh media); jangan await agar loop pesan tidak macet
        void this.extractFile(raw).catch(() => undefined);
      } catch { /* satu pesan rusak tak boleh menggagalkan yang lain */ }
    }
  }

  private async extractFile(raw: unknown): Promise<void> {
    const msg = raw as {
      key?: { remoteJid?: string; id?: string; fromMe?: boolean };
      message?: Record<string, any>;
      messageTimestamp?: number;
      pushName?: string;
    };
    const jid = msg.key?.remoteJid ?? '';
    const msgId = msg.key?.id ?? '';
    if (!jid || !msgId) return;
    // Hanya direct chat (@s.whatsapp.net) — bukan grup/status/broadcast.
    if (!jid.endsWith('@s.whatsapp.net')) return;

    const b = await this.ensureBaileys();
    const downloadContentFromMessage = b.downloadContentFromMessage as
      | ((msg: unknown, type: string) => Promise<NodeJS.ReadableStream>)
      | undefined;
    if (!downloadContentFromMessage) return;

    const m = msg.message ?? {};
    // Kandung pesan bersarang (viewOnce, edited, dll)
    const inner = m.ephemeralMessage?.message ?? m.viewOnceMessage?.message
      ?? m.viewOnceMessageV2?.message ?? m.editedMessage?.message ?? m;

    // Media di WhatsApp tidak dibawa sebagai base64 — hanya direferensikan
    // lewat mediaKey/directPath. Kita harus unduh lewat stream, lalu buffer.
    let kind: 'document' | 'image' | 'video' | 'audio' | null = null;
    let node: Record<string, any> | null = null;
    if (inner.documentMessage) { kind = 'document'; node = inner.documentMessage; }
    else if (inner.imageMessage) { kind = 'image'; node = inner.imageMessage; }
    else if (inner.videoMessage) { kind = 'video'; node = inner.videoMessage; }
    else if (inner.audioMessage) { kind = 'audio'; node = inner.audioMessage; }
    if (!kind || !node) return;

    let data: Buffer;
    try {
      const stream = await downloadContentFromMessage(node, kind);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      data = Buffer.concat(chunks);
    } catch {
      return; // unduhan gagal (kunci kedaluwarsa, dsb.) → lewati pesan ini
    }
    if (data.length === 0) return;

    const fallbackExt = kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : kind === 'audio' ? 'opus' : 'bin';
    const name = node.fileName
      ?? `wa-${new Date().toISOString().replace(/[:.]/g, '-')}.${fallbackExt}`;

    const file: WaMessageFile = {
      chatJid: jid,
      msgId,
      name,
      mime: node.mimeType ?? 'application/octet-stream',
      size: node.fileLength ?? data.length,
      data,
      timestamp: typeof msg.messageTimestamp === 'number' ? msg.messageTimestamp : Date.now() / 1000,
      senderName: msg.pushName,
    };
    for (const h of this.fileHandlers) {
      try { h(file); } catch { /* handler app tak boleh merusak loop */ }
    }
  }

  async disconnect(): Promise<void> {
    this.wantReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try {
      const sock = this.sock as { logout?: () => Promise<void> } | null;
      await sock?.logout?.().catch(() => undefined);
    } catch { /* abaikan */ }
    this.sock = null;
    await this.auth.clear();
    this.setState('disconnected', { qr: null, phone: null, error: null });
  }

  destroy(): void {
    this.destroyed = true;
    this.wantReconnect = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    try {
      const sock = this.sock as { end?: (e?: unknown) => void } | null;
      sock?.end?.(undefined);
    } catch { /* abaikan */ }
    this.sock = null;
    this.fileHandlers = [];
    this.statusHandlers = [];
    this.removeAllListeners();
  }
}

/** Pastikan direktori data WA ada. */
export async function ensureWaDataDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch(() => undefined);
}
