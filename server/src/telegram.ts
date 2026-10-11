import { writeFile } from 'node:fs/promises';
import tp from 'teleproto';
const { TelegramClient, Api, password } = tp;
const { StringSession } = tp.sessions;

/** Hasil kirim pesan file ke topik grup forum. */
export interface SentFileResult { messageId: number; groupId: number }

export interface MeInfo { id: number; firstName: string; username?: string }

/** Grup forum tunggal yang menampung semua kategori (topik). */
export interface DriveGroupInfo { groupId: number; title: string }

/** Topik kategori di dalam grup forum (topicId = id pesan root topik). */
export interface TopicInfo { topicId: number; title: string }

/**
 * Kontrak gateway Telegram — semua rute memakai interface ini,
 * sehingga bisa diuji dengan fake tanpa jaringan.
 */
export interface TelegramGateway {
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<{ twoFa: boolean }>;
  checkPassword(password: string): Promise<void>;
  getMe(): Promise<MeInfo>;
  /** Cari (atau buat) grup forum drive — idempoten berdasarkan judul. */
  ensureDriveGroup(title: string, about: string): Promise<DriveGroupInfo>;
  /** Cari (atau buat) topik kategori di grup forum — idempoten berdasarkan judul. */
  ensureTopic(groupId: number, title: string): Promise<TopicInfo>;
  /** Kirim file ke topik (group + topic) dalam grup forum. */
  sendFileToTopic(groupId: number, topicId: number, filePath: string, caption: string): Promise<SentFileResult>;
  /** Unduh media pesan dari Telegram ke path tujuan; mengembalikan path hasil. */
  downloadFile(groupId: number, messageId: number, destPath: string): Promise<string>;
  sessionString(): string;
  destroy(): void;
}

export type TelegramFactory = (apiId: number, apiHash: string, session?: string) => Promise<TelegramGateway>;

/** Error API Telegram → kode ramah aplikasi. */
export function mapTelegramError(err: unknown): { code: string; retryAfterSeconds?: number } {
  const msg = err instanceof Error ? err.message : String(err);
  // teleproto 1.23: err.message = teks human-readable ("API ID invalid."),
  // sedangkan kode mentah ada di err.errorMessage ("API_ID_INVALID"),
  // dan FloodWaitError menyimpan detik di properti .seconds.
  // Karena itu pencocokan WAJIB memakai errorMessage + seconds, bukan message saja.
  const rpc = err as { errorMessage?: string; seconds?: number };
  const haystack = `${rpc.errorMessage ?? ''} ${msg}`;
  if (typeof rpc.seconds === 'number' || /FLOOD_WAIT_?\d+/i.test(haystack)) {
    return { code: 'FLOOD_WAIT', retryAfterSeconds: rpc.seconds ?? extractSeconds(msg) };
  }
  if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/.test(haystack)) return { code: 'PHONE_CODE_INVALID' };
  if (/PHONE_NUMBER_INVALID/.test(haystack)) return { code: 'PHONE_NUMBER_INVALID' };
  if (/SESSION_PASSWORD_NEEDED/.test(haystack)) return { code: 'SESSION_PASSWORD_NEEDED' };
  if (/PASSWORD_HASH_INVALID/.test(haystack)) return { code: 'PASSWORD_INVALID' };
  if (/API_ID_INVALID|API_HASH_INVALID/.test(haystack)) return { code: 'API_INVALID' };
  return { code: 'TELEGRAM_ERROR' };
}

function extractSeconds(msg: string): number | undefined {
  const m = /FLOOD_WAIT_?(\d+)/i.exec(msg) ?? /wait (\d+) seconds/i.exec(msg);
  return m ? parseInt(m[1]!, 10) : undefined;
}

/** Gateway nyata berbasis teleproto (MTProto). Satu instance = satu sesi Telegram. */
export class TeleprotoGateway implements TelegramGateway {
  private constructor(
    private readonly client: InstanceType<typeof TelegramClient>,
    private readonly apiId: number,
    private readonly apiHash: string,
  ) {}

  static async create(apiId: number, apiHash: string, session?: string): Promise<TeleprotoGateway> {
    const client = new TelegramClient(new StringSession(session ?? ''), apiId, apiHash, {
      connectionRetries: 5,
    });
    await client.connect();
    return new TeleprotoGateway(client, apiId, apiHash);
  }

  async sendCode(phone: string): Promise<{ phoneCodeHash: string }> {
    const res = await this.client.invoke(
      new Api.auth.SendCode({
        phoneNumber: phone,
        apiId: this.apiId,
        apiHash: this.apiHash,
        settings: new Api.CodeSettings({ allowAppHash: true }),
      }),
    ) as { phoneCodeHash: string };
    return { phoneCodeHash: res.phoneCodeHash };
  }

  async signIn(phone: string, phoneCodeHash: string, code: string): Promise<{ twoFa: boolean }> {
    try {
      await this.client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      return { twoFa: false };
    } catch (err) {
      // Cek via errorMessage (kode mentah) — pesan teleproto human-readable,
      // String(err) tidak pernah berisi "SESSION_PASSWORD_NEEDED".
      if (mapTelegramError(err).code === 'SESSION_PASSWORD_NEEDED') return { twoFa: true };
      throw err;
    }
  }

  async checkPassword(pw: string): Promise<void> {
    const pwd = await this.client.invoke(new Api.account.GetPassword()) as Parameters<typeof password.computeCheck>[0];
    const srp = await password.computeCheck(pwd, pw);
    await this.client.invoke(new Api.auth.CheckPassword({ password: srp }));
  }

  async getMe(): Promise<MeInfo> {
    const me = await this.client.getMe();
    return { id: Number(me.id), firstName: me.firstName ?? '', username: me.username ?? undefined };
  }

  /**
   * Cari grup forum berdasarkan judul persis di dialog; kalau belum ada, buat baru
   * (megagroup + forum). Grup non-forum yang judulnya sama → forum-nya diaktifkan.
   */
  async ensureDriveGroup(title: string, about: string): Promise<DriveGroupInfo> {
    for await (const dialog of this.client.iterDialogs()) {
      const entity = dialog.entity as unknown as {
        className?: string; title?: string; id: bigint | number; megagroup?: boolean; forum?: boolean;
      };
      if (entity.className === 'Channel' && entity.megagroup && entity.title === title) {
        const groupId = Number(entity.id);
        if (!entity.forum) await this.client.toggleForum(groupId, true);
        return { groupId, title };
      }
    }
    const res = await this.client.invoke(
      new Api.channels.CreateChannel({ megagroup: true, forum: true, title, about }),
    ) as unknown as { chats: Array<{ id: bigint | number; title?: string }> };
    const chat = res.chats[0];
    if (!chat) throw new Error('CreateGroup tidak mengembalikan grup');
    return { groupId: Number(chat.id), title: chat.title ?? title };
  }

  /** Cari topik kategori by judul; kalau belum ada, buat (CreateForumTopic). Idempoten. */
  async ensureTopic(groupId: number, title: string): Promise<TopicInfo> {
    const found = await this.findTopicByTitle(groupId, title);
    if (found) return { topicId: found, title };
    await this.client.createForumTopic(groupId, { title });
    const created = await this.findTopicByTitle(groupId, title);
    if (created == null) throw new Error(`CreateForumTopic: topik "${title}" tidak ditemukan setelah dibuat`);
    return { topicId: created, title };
  }

  private async findTopicByTitle(groupId: number, title: string): Promise<number | null> {
    const res = await this.client.getForumTopics(groupId, { limit: 100 }) as unknown as {
      topics: Array<{ className?: string; id: number; title: string }>;
    };
    const hit = res.topics.find((t) => t.className === 'ForumTopic' && t.title === title);
    return hit ? hit.id : null;
  }

  async sendFileToTopic(groupId: number, topicId: number, filePath: string, caption: string): Promise<SentFileResult> {
    const msg = (await this.client.sendFile(groupId, {
      file: filePath,
      caption,
      replyTo: topicId,
      topMsgId: topicId,
    })) as { id: number };
    return { messageId: msg.id, groupId };
  }

  /**
   * Ambil pesan (by id) dari grup lalu unduh medianya ke destPath.
   * downloadMedia menulis ke file bila outputFile diberikan; kalau mengembalikan
   * Buffer (ukuran kecil), tulis manual.
   */
  async downloadFile(groupId: number, messageId: number, destPath: string): Promise<string> {
    // Angka polos positif = user; grup/channel harus pakai peer marked "-100<id>".
    const markedId = -(1_000_000_000_000 + groupId);
    const msgs = await this.client.getMessages(markedId, { ids: [messageId] });
    const msg = msgs[0];
    if (!msg) throw new Error('MESSAGE_NOT_FOUND');
    const out = await this.client.downloadMedia(msg, { outputFile: destPath });
    if (typeof out === 'string') return out;
    if (out && typeof out === 'object' && 'length' in out) {
      await writeFile(destPath, out);
      return destPath;
    }
    throw new Error('MEDIA_EMPTY');
  }

  sessionString(): string {
    return (this.client.session as { save(): string }).save();
  }

  destroy(): void {
    void this.client.disconnect();
  }
}

/** Factory default untuk produksi. */
export const createRealGateway: TelegramFactory = async (apiId, apiHash, session) =>
  TeleprotoGateway.create(apiId, apiHash, session);
