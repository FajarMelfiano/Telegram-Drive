// Penyimpanan sesi Telegram di SecureStore (Keychain/Keystore Android).
// Keputusan (disepakati): api_id + api_hash + session string disimpan terenkripsi
// at-rest oleh OS, bukan di SQLite mentah seperti server (karena server berbagi
// host). Session string = akses penuh ke akun Telegram, jadi wajib di SecureStore.
import * as SecureStore from 'expo-secure-store';

const SERVICE = 'telegram-drive';
const KEY = 'tg.session';

export interface StoredSession {
  apiId: number;
  apiHash: string;
  session: string;
  phone: string | null;
  tgUserId: number | null;
  tgName: string | null;
}

/** Batas nilai SecureStore per entri (iOS) — session string teleproto jauh di bawah ini. */

export async function saveSession(s: StoredSession): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(s), {
    keychainService: SERVICE,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY, { keychainService: SERVICE });
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export async function deleteSession(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, { keychainService: SERVICE }).catch(() => undefined);
}
