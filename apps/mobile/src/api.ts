import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/** Default: server lokal. Di Android emulator pakai 10.0.2.2, di web bebas. */
const DEFAULT_BASE = Platform.select({
  android: 'http://10.0.2.2:8787',
  default: 'http://localhost:8787',
});
export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_BASE;

const TOKEN_KEY = 'td.jwt';
const REFRESH_KEY = 'td.refresh';
// Web pakai cookie httpOnly untuk refresh (js tak bisa membacanya) — hanya token
// akses yang disimpan di storage. Native menyimpan refresh di SecureStore.
const isWeb = Platform.OS === 'web';

/** Penyimpanan aman: SecureStore di native (enkripsi at-rest), AsyncStorage di web. */
async function storeGet(key: string): Promise<string | null> {
  if (isWeb) return AsyncStorage.getItem(key);
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}
async function storeSet(key: string, value: string): Promise<void> {
  if (isWeb) return AsyncStorage.setItem(key, value);
  try {
    await SecureStore.setItemAsync(key, value);
  } catch {
    /* noop — SecureStore gagal tak boleh menjatuhkan login */
  }
}
async function storeDel(key: string): Promise<void> {
  if (isWeb) return AsyncStorage.removeItem(key);
  try {
    await SecureStore.deleteItemAsync(key);
  } catch {
    /* noop */
  }
}

export async function getToken(): Promise<string | null> {
  return storeGet(TOKEN_KEY);
}
export async function setToken(t: string): Promise<void> {
  await storeSet(TOKEN_KEY, t);
}
export async function clearToken(): Promise<void> {
  await storeDel(TOKEN_KEY);
  await storeDel(REFRESH_KEY);
}
export async function getRefreshToken(): Promise<string | null> {
  if (isWeb) return null; // web: cookie httpOnly, tak bisa dibaca JS
  return storeGet(REFRESH_KEY);
}
export async function setRefreshToken(t: string): Promise<void> {
  if (isWeb) return; // web: cookie httpOnly diatur server
  await storeSet(REFRESH_KEY, t);
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterSeconds?: number) {
    super(code);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  formData?: FormData;
  signal?: AbortSignal;
  /** internal: penanda sudah pernah retry setelah refresh */
  _retried?: boolean;
  /** set false untuk menonaktifkan auto-refresh (mis. panggilan auth sendiri) */
  _canRefresh?: boolean;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData; // biarkan fetch menetapkan boundary
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const doFetch = (b: BodyInit | undefined, hdr: Record<string, string>) =>
    fetch(`${API_BASE}${path}`, {
      method: opts.method ?? (b ? 'POST' : 'GET'),
      headers: hdr, body: b, signal: opts.signal,
      // Web: kirim cookie refresh httpOnly untuk /auth/refresh
      credentials: isWeb ? 'include' : 'same-origin',
    });

  let res = await doFetch(body, headers);
  let text = res.status === 204 ? '' : await res.text();

  // Auto-refresh: token akses kedaluwarsa → tukar refresh (sekali, hindari loop).
  if (res.status === 401 && !opts._retried && opts._canRefresh !== false) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      opts._retried = true;
      headers.authorization = `Bearer ${refreshed}`;
      res = await doFetch(body, headers);
      text = res.status === 204 ? '' : await res.text();
    }
  }

  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, json.error ?? 'UNKNOWN', json.retryAfterSeconds);
  }
  return json as T;
}

// ---- auto-refresh (tukar token akses kedaluwarsa) ----
let refreshInFlight: Promise<string | null> | null = null;

/** Tukar refresh token → token akses baru. Aman dipanggil berulang (dedupe in-flight). */
export async function tryRefresh(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const stored = await getRefreshToken();
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stored ? JSON.stringify({ refreshToken: stored }) : undefined,
        credentials: isWeb ? 'include' : 'same-origin',
      });
      if (!res.ok) {
        if (res.status !== 401 && res.status !== 410) return null; // jangan logout pada error jaringan
        await clearToken();
        return null;
      }
      const data = (await res.json()) as { token: string; refreshToken?: string };
      await setToken(data.token);
      if (data.refreshToken) await setRefreshToken(data.refreshToken);
      return data.token;
    } catch {
      return null; // jaringan gagal → biarkan caller dapat ApiError asli
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ---- tipe respons (mencerminkan kontrak server) ----
export interface FileRow {
  id: number; fileUid: string; name: string; ext: string | null; mime: string | null;
  size: number; categoryId: number; categoryKey: string;
  channelId: number | null; messageId: number | null; uploadedAt: string; state: string;
  displayName?: string | null; tags?: string[]; source?: string;
  chatJid?: string | null; waMsgId?: string | null;
}
export interface CategoryRow {
  id: number; key: string; label: string;
  channelId: number | null; channelTitle: string | null; state: string; fileCount: number;
}
export interface ParsedQuery {
  text: string; ext: string | null; category: string | null;
  dateFrom: string | null; dateTo: string | null; minSize: number | null;
}
export interface DeviceRow {
  id: number; label: string; userAgent: string | null; createdAt: string; lastSeenAt: string;
}
export interface AlbumRow { id: number; name: string; createdAt: string; fileCount: number }
export interface ActivityRow { id: number; type: string; detail: unknown; createdAt: string }
export interface StatsResult {
  totalFiles: number; totalBytes: number;
  byCategory: { key: string; count: number; bytes: number }[];
  byExt: { ext: string; count: number }[];
  bySource: { source: string; count: number }[];
}
export interface WaStatus { state: string; qr: string | null; phone: string | null; lastError: string | null }

// ---- aksi API ----
export const Api = {
  startAuth: (apiId: number, apiHash: string, phone: string, token: string | null) =>
    api<{ requestId: string }>('/auth/start', { body: { apiId, apiHash, phone }, token }),
  verify: (requestId: string, code: string, token: string | null) =>
    api<{ status?: string; token?: string; refreshToken?: string; me?: unknown }>('/auth/verify', { body: { requestId, code }, token, _canRefresh: false }),
  password: (requestId: string, password: string, token: string | null) =>
    api<{ token: string; refreshToken?: string; me?: unknown }>('/auth/password', { body: { requestId, password }, token, _canRefresh: false }),
  me: (token: string | null) =>
    api<{ me: { id: number; firstName: string; username?: string }; phone: string | null }>('/me', { token }),
  logout: (token: string | null) => api<{ ok: boolean }>('/auth/logout', { method: 'POST', token }),
  categories: (token: string | null) => api<{ categories: CategoryRow[] }>('/categories', { token }),
  files: (token: string | null, category?: string) =>
    api<{ files: FileRow[] }>(`/files?limit=200${category ? `&category=${encodeURIComponent(category)}` : ''}`, { token }),
  search: (token: string | null, q: string) =>
    api<{ parsed: ParsedQuery; results: FileRow[] }>(`/search?q=${encodeURIComponent(q)}`, { token }),
  syncStatus: (token: string | null) => api<{ pending: number; sent: number }>('/sync/status', { token }),
  upload: async (token: string | null, file: { uri: string; name: string; type: string }, clientUploadId?: string) => {
    const form = new FormData();
    if (Platform.OS === 'web') {
      // Web: uri adalah blob URL — ubah dulu jadi Blob agar ikut terkirim
      const blob = await (await fetch(file.uri)).blob();
      form.append('file', blob, file.name);
    } else {
      // React Native: objek {uri,name,type} adalah format bawaan FormData
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
    }
    // Kunci idempoten → server mengembalikan file lama bila retry (tak menggandakan)
    const q = clientUploadId ? `?clientUploadId=${encodeURIComponent(clientUploadId)}` : '';
    return api<{ file: FileRow; deduped?: boolean }>(`/files${q}`, { token, formData: form });
  },

  // ---- aksi file (drive) ----
  rename: (token: string | null, id: number, displayName: string) =>
    api<{ file: FileRow }>(`/files/${id}`, { method: 'PATCH', body: { displayName }, token }),
  setTags: (token: string | null, id: number, tags: string[]) =>
    api<{ file: FileRow }>(`/files/${id}`, { method: 'PATCH', body: { tags }, token }),
  removeFile: (token: string | null, id: number) =>
    api<{ ok: boolean }>(`/files/${id}`, { method: 'DELETE', token }),
  moveFile: (token: string | null, id: number, category: string) =>
    api<{ file: FileRow }>(`/files/${id}/category`, { method: 'PATCH', body: { category }, token }),
  batch: (token: string | null, action: 'delete' | 'move' | 'tag', ids: number[], extra?: { category?: string; tags?: string[] }) =>
    api<{ results: { id: number; ok: boolean; error?: string }[] }>('/files/batch', {
      method: 'POST', body: { action, ids, ...extra }, token,
    }),
  zipUrl: (token: string | null, ids: number[]) =>
    `${API_BASE}/files/zip?ids=${ids.join(',')}&token=${encodeURIComponent(token ?? '')}`,

  // ---- statistik & aktivitas ----
  stats: (token: string | null) => api<StatsResult>('/stats', { token }),
  activity: (token: string | null, limit = 50) =>
    api<{ activity: ActivityRow[] }>(`/activity?limit=${limit}`, { token }),

  // ---- album ----
  albums: (token: string | null) => api<{ albums: AlbumRow[] }>('/albums', { token }),
  createAlbum: (token: string | null, name: string) =>
    api<{ album: AlbumRow }>('/albums', { body: { name }, token }),
  renameAlbum: (token: string | null, id: number, name: string) =>
    api<{ album: AlbumRow }>(`/albums/${id}`, { method: 'PATCH', body: { name }, token }),
  deleteAlbum: (token: string | null, id: number) =>
    api<{ ok: boolean }>(`/albums/${id}`, { method: 'DELETE', token }),
  albumFiles: (token: string | null, id: number) =>
    api<{ files: FileRow[] }>(`/albums/${id}/files`, { token }),
  addToAlbum: (token: string | null, id: number, fileIds: number[]) =>
    api<{ added: number; files: FileRow[] }>(`/albums/${id}/files`, { method: 'POST', body: { fileIds }, token }),
  removeFromAlbum: (token: string | null, id: number, fileId: number) =>
    api<{ ok: boolean }>(`/albums/${id}/files/${fileId}`, { method: 'DELETE', token }),

  // ---- perangkat & sesi ----
  devices: (token: string | null) => api<{ devices: DeviceRow[] }>('/devices', { token }),
  removeDevice: (token: string | null, id: number) =>
    api<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE', token }),
  refresh: (refreshToken: string) =>
    api<{ token: string; refreshToken: string }>('/auth/refresh', { body: { refreshToken } }),

  // ---- pairing QR (login web dari HP: web buat kode, HP scan+approve) ----
  createPairing: (deviceLabel = 'Web') =>
    api<{ code: string; expiresIn: number }>('/auth/pairing', { body: { deviceLabel }, _canRefresh: false }),
  pollPairing: (code: string) =>
    api<{ status: 'pending' | 'approved' | 'redeemed' }>(`/auth/pairing/${code}`, { _canRefresh: false }),
  claimPairing: (code: string) =>
    api<{ token: string; refreshToken: string }>(`/auth/pairing/${code}/claim`, { method: 'POST', _canRefresh: false }),
  /** HP yang sudah login menyetujui kode hasil pindaian QR web. */
  approvePairing: (token: string | null, code: string) =>
    api<{ ok: boolean }>(`/auth/pairing/${code}/approve`, { method: 'POST', token }),

  // ---- WhatsApp ----
  waStatus: (token: string | null) => api<WaStatus>('/wa/status', { token }),
  waConnect: (token: string | null) => api<WaStatus>('/wa/connect', { method: 'POST', token }),
  waDisconnect: (token: string | null) => api<WaStatus>('/wa/disconnect', { method: 'POST', token }),
};

/** URL unduh (auth lewat ?token= — aman dipakai <img> dan link langsung). */
export function fileDownloadUrl(file: FileRow, token: string | null): string {
  return `${API_BASE}/files/${file.id}/download?token=${encodeURIComponent(token ?? '')}`;
}

/**
 * Unduh file ke perangkat. Web: navigate ke URL (server kirim disposition
 * attachment → browser mengunduh dengan nama asli). Native: buka via browser.
 */
export async function downloadFile(token: string | null, file: FileRow): Promise<void> {
  const url = fileDownloadUrl(file, token);
  if (Platform.OS === 'web') {
    (globalThis as unknown as { location: { href: string } }).location.href = url;
    return;
  }
  const { Linking } = await import('react-native');
  const ok = await Linking.canOpenURL(url);
  if (!ok) throw new ApiError(0, 'CANNOT_OPEN_URL');
  await Linking.openURL(url);
}
