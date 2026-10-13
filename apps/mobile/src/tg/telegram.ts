// Port dari server/src/telegram.ts — kontrak TelegramGateway dijaga identik.
// Perubahan di sini: (1) tidak ada node:fs; (2) sendFile/downloadFile memakai
// Buffer yang dibaca/ditulis via expo-file-system, karena teleproto di Hermes
// tidak punya akses fs nyata (stubs). Semua logika MTProto tetap teleproto.
import * as FileSystem from 'expo-file-system/legacy';
import {
  TelegramClient,
  Api as TgApi,
  password as tgPassword,
  sessions,
  extensions,
} from 'teleproto';

const { StringSession } = sessions;

/** Hasil kirim pesan file ke topik grup forum. */
export interface SentFileResult { messageId: number; groupId: number }
export interface MeInfo { id: number; firstName: string; username?: string }
export interface DriveGroupInfo { groupId: number; title: string }
export interface TopicInfo { topicId: number; title: string }

export interface TelegramGateway {
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<{ twoFa: boolean }>;
  checkPassword(password: string): Promise<void>;
  getMe(): Promise<MeInfo>;
  ensureDriveGroup(title: string, about: string): Promise<DriveGroupInfo>;
  ensureTopic(groupId: number, title: string): Promise<TopicInfo>;
  sendFileToTopic(groupId: number, topicId: number, data: Buffer, caption: string): Promise<SentFileResult>;
  downloadFile(groupId: number, messageId: number, destPath: string): Promise<string>;
  deleteMessages(groupId: number, messageIds: number[]): Promise<void>;
  editCaption(groupId: number, messageId: number, caption: string): Promise<void>;
  sessionString(): string;
  destroy(): void;
}

export type TelegramFactory = (apiId: number, apiHash: string, session?: string) => Promise<TelegramGateway>;

/** Error API Telegram → kode ramah aplikasi. */
export function mapTelegramError(err: unknown): { code: string; retryAfterSeconds?: number } {
  const msg = err instanceof Error ? err.message : String(err);
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

/** Buffer → base64 (untuk tulis via expo-file-system legacy). */
function bufToBase64(buf: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  // Gunakan Buffer global (sudah di-polyfill) untuk encoding base64 yang benar.
  return Buffer.from(binary, 'binary').toString('base64');
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
      // Hermes/RN tidak punya net.Socket (stub melempar) — wajib transport
      // WebSocket. Server sengaja memakai default TCP; di APK kita ganti ke
      // PromisedWebSockets (sama seperti Spike B yang terbukti jalan di Android).
      networkSocket: extensions.PromisedWebSockets,
    });
    await client.connect();
    return new TeleprotoGateway(client, apiId, apiHash);
  }

  async sendCode(phone: string): Promise<{ phoneCodeHash: string }> {
    const res = await this.client.invoke(
      new TgApi.auth.SendCode({
        phoneNumber: phone,
        apiId: this.apiId,
        apiHash: this.apiHash,
        settings: new TgApi.CodeSettings({ allowAppHash: true }),
      }),
    ) as { phoneCodeHash: string };
    return { phoneCodeHash: res.phoneCodeHash };
  }

  async signIn(phone: string, phoneCodeHash: string, code: string): Promise<{ twoFa: boolean }> {
    try {
      await this.client.invoke(new TgApi.auth.SignIn({ phoneNumber: phone, phoneCodeHash, phoneCode: code }));
      return { twoFa: false };
    } catch (err) {
      if (mapTelegramError(err).code === 'SESSION_PASSWORD_NEEDED') return { twoFa: true };
      throw err;
    }
  }

  async checkPassword(pw: string): Promise<void> {
    const pwd = await this.client.invoke(new TgApi.account.GetPassword()) as Parameters<typeof tgPassword.computeCheck>[0];
    const srp = await tgPassword.computeCheck(pwd, pw);
    await this.client.invoke(new TgApi.auth.CheckPassword({ password: srp }));
  }

  async getMe(): Promise<MeInfo> {
    const me = await this.client.getMe();
    return { id: Number(me.id), firstName: me.firstName ?? '', username: me.username ?? undefined };
  }

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
      new TgApi.channels.CreateChannel({ megagroup: true, forum: true, title, about }),
    ) as unknown as { chats: { id: bigint | number; title?: string }[] };
    const chat = res.chats[0];
    if (!chat) throw new Error('CreateGroup tidak mengembalikan grup');
    return { groupId: Number(chat.id), title: chat.title ?? title };
  }

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
      topics: { className?: string; id: number; title: string }[];
    };
    const hit = res.topics.find((t) => t.className === 'ForumTopic' && t.title === title);
    return hit ? hit.id : null;
  }

  async sendFileToTopic(groupId: number, topicId: number, data: Buffer, caption: string): Promise<SentFileResult> {
    // teleproto mengirim Buffer sebagai media mentah (custom file), tanpa fs.
    const msg = (await this.client.sendFile(groupId, {
      file: data,
      caption,
      replyTo: topicId,
      topMsgId: topicId,
    })) as { id: number };
    return { messageId: msg.id, groupId };
  }

  /** Unduh media pesan ke destPath (tulis base64 via expo-file-system). */
  async downloadFile(groupId: number, messageId: number, destPath: string): Promise<string> {
    const markedId = -(1_000_000_000_000 + groupId);
    const msgs = await this.client.getMessages(markedId, { ids: [messageId] });
    const msg = msgs[0];
    if (!msg) throw new Error('MESSAGE_NOT_FOUND');
    // Tanpa outputFile → teleproto mengembalikan Buffer.
    const out = await this.client.downloadMedia(msg);
    if (out && typeof out === 'object' && 'length' in out) {
      await FileSystem.writeAsStringAsync(destPath, bufToBase64(out as Uint8Array), {
        encoding: FileSystem.EncodingType.Base64,
      });
      return destPath;
    }
    throw new Error('MEDIA_EMPTY');
  }

  async deleteMessages(groupId: number, messageIds: number[]): Promise<void> {
    if (messageIds.length === 0) return;
    const markedId = -(1_000_000_000_000 + groupId);
    await this.client.deleteMessages(markedId, messageIds, { revoke: true });
  }

  async editCaption(groupId: number, messageId: number, caption: string): Promise<void> {
    const markedId = -(1_000_000_000_000 + groupId);
    await this.client.editMessage(markedId, { message: messageId, text: caption });
  }

  sessionString(): string {
    return (this.client.session as { save(): string }).save();
  }

  destroy(): void {
    void this.client.disconnect();
  }
}

export const createRealGateway: TelegramFactory = async (apiId, apiHash, session) =>
  TeleprotoGateway.create(apiId, apiHash, session);
