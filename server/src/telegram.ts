import tp from 'teleproto';
const { TelegramClient, Api, password } = tp;
const { StringSession } = tp.sessions;

/** Hasil kirim pesan file ke channel. */
export interface SentFileResult { messageId: number; channelId: number }

export interface ChannelInfo { channelId: number; title: string }

export interface MeInfo { id: number; firstName: string; username?: string }

/**
 * Kontrak gateway Telegram — semua rute memakai interface ini,
 * sehingga bisa diuji dengan fake tanpa jaringan.
 */
export interface TelegramGateway {
  sendCode(phone: string): Promise<{ phoneCodeHash: string }>;
  signIn(phone: string, phoneCodeHash: string, code: string): Promise<{ twoFa: boolean }>;
  checkPassword(password: string): Promise<void>;
  getMe(): Promise<MeInfo>;
  ensureCategoryChannel(title: string, about: string): Promise<ChannelInfo>;
  sendFileToChannel(channelId: number, filePath: string, caption: string): Promise<SentFileResult>;
  sessionString(): string;
  destroy(): void;
}

export type TelegramFactory = (apiId: number, apiHash: string, session?: string) => Promise<TelegramGateway>;

/** Error API Telegram → kode ramah aplikasi. */
export function mapTelegramError(err: unknown): { code: string; retryAfterSeconds?: number } {
  const msg = err instanceof Error ? err.message : String(err);
  const anyErr = err as { seconds?: number; errorCode?: number };
  if (/FLOOD_WAIT/i.test(msg)) {
    return { code: 'FLOOD_WAIT', retryAfterSeconds: anyErr.seconds ?? extractSeconds(msg) };
  }
  if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/.test(msg)) return { code: 'PHONE_CODE_INVALID' };
  if (/PHONE_NUMBER_INVALID/.test(msg)) return { code: 'PHONE_NUMBER_INVALID' };
  if (/SESSION_PASSWORD_NEEDED/.test(msg)) return { code: 'SESSION_PASSWORD_NEEDED' };
  if (/PASSWORD_HASH_INVALID/.test(msg)) return { code: 'PASSWORD_INVALID' };
  if (/API_ID_INVALID|API_HASH_INVALID/.test(msg)) return { code: 'API_INVALID' };
  return { code: 'TELEGRAM_ERROR' };
}

function extractSeconds(msg: string): number | undefined {
  const m = /FLOOD_WAIT_?(\d+)/i.exec(msg);
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
      if (/SESSION_PASSWORD_NEEDED/i.test(String(err))) return { twoFa: true };
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

  /** Cari channel berdasarkan judul persis di dialog; kalau belum ada, buat baru (broadcast). */
  async ensureCategoryChannel(title: string, about: string): Promise<ChannelInfo> {
    for await (const dialog of this.client.iterDialogs()) {
      const entity = dialog.entity as unknown as { title?: string; id: bigint | number; className?: string };
      if (entity.className === 'Channel' && entity.title === title) {
        return { channelId: Number(entity.id), title };
      }
    }
    const res = await this.client.invoke(
      new Api.channels.CreateChannel({ title, about, broadcast: true }),
    ) as unknown as { chats: Array<{ id: bigint | number; title?: string }> };
    const chat = res.chats[0];
    if (!chat) throw new Error('CreateChannel tidak mengembalikan channel');
    return { channelId: Number(chat.id), title: chat.title ?? title };
  }

  async sendFileToChannel(channelId: number, filePath: string, caption: string): Promise<SentFileResult> {
    const msg = (await this.client.sendFile(channelId, { file: filePath, caption })) as { id: number };
    return { messageId: msg.id, channelId };
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
