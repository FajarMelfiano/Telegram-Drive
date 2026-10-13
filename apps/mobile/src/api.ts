// Kontrak API — DIPERTAHANKAN identik dengan aslinya (server Fastify).
//
// Perubahan transport (port mandiri / Spike B → P3): pada native (Android/iOS)
// `api()` memanggil router LOKAL (src/tg/localApi.ts) yang meniru rute server di
// atas SQLite + teleproto, tanpa jaringan. Web tetap `fetch` ke server (mode dev
// lama). Seluruh bentuk `Api` + tipe respons di bawah tidak berubah.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useEffect, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';
import { localApi, materializeFile, materializePreview, getPreviewUri } from './tg/localApi';

const TOKEN_KEY = 'td.jwt';
const REFRESH_KEY = 'td.refresh';
const isWeb = Platform.OS === 'web';
const isNative = !isWeb;

/** Default: server lokal (hanya dipakai mode web). */
const DEFAULT_BASE = Platform.select({
  android: 'http://10.0.2.2:8787',
  default: 'http://localhost:8787',
});
export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_BASE;

/** Penyimpanan aman: SecureStore di native, AsyncStorage di web. */
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
    /* noop */
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
  if (isWeb) return null;
  return storeGet(REFRESH_KEY);
}
export async function setRefreshToken(t: string): Promise<void> {
  if (isWeb) return;
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
  _retried?: boolean;
  _canRefresh?: boolean;
}

function methodOf(opts: RequestOptions): string {
  return opts.method ?? (opts.body !== undefined || opts.formData ? 'POST' : 'GET');
}

/**
 * Transport utama. Native → router lokal (self-contained). Web → fetch server
 * (termasuk auto-refresh via cookie httpOnly, sama seperti aslinya).
 */
export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  if (isNative) {
    try {
      return await localApi<T>(methodOf(opts), path, {
        body: opts.body, formData: opts.formData,
      });
    } catch (err) {
      // Router lokal melempar ApiError sendiri — lewatkan apa adanya.
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, err instanceof Error ? err.message : 'UNKNOWN');
    }
  }

  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const doFetch = (b: BodyInit | undefined, hdr: Record<string, string>) =>
    fetch(`${API_BASE}${path}`, {
      method: methodOf(opts),
      headers: hdr, body: b, signal: opts.signal,
      credentials: isWeb ? 'include' : 'same-origin',
    });

  let res = await doFetch(body, headers);
  let text = res.status === 204 ? '' : await res.text();

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

// ---- auto-refresh (hanya mode web; native tidak punya refresh token) ----
let refreshInFlight: Promise<string | null> | null = null;

export async function tryRefresh(): Promise<string | null> {
  if (isNative) return null; // lokal: tak ada refresh token — biarkan caller 401
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const stored = await getRefreshToken();
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: stored ? JSON.stringify({ refreshToken: stored }) : undefined,
        credentials: 'include',
      });
      if (!res.ok) {
        if (res.status !== 401 && res.status !== 410) return null;
        await clearToken();
        return null;
      }
      const data = (await res.json()) as { token: string; refreshToken?: string };
      await setToken(data.token);
      if (data.refreshToken) await setRefreshToken(data.refreshToken);
      return data.token;
    } catch {
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// ---- tipe respons (mencerminkan kontrak server) — TIDAK BERUBAH ----
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

// ---- aksi API — TIDAK BERUBAH ----
/**
 * Preview file. Web: URL server (stream dari Telegram). Native: URI `file://`
 * dari cache hasil materialisasi — sinkron; "" bila belum tersedia.
 */
export function fileDownloadUrl(file: FileRow, token: string | null): string {
  if (isWeb) return `${API_BASE}/files/${file.id}/download?token=${encodeURIComponent(token ?? '')}`;
  return getPreviewUri(file.id) ?? '';
}

/**
 * Hook preview untuk <Image>: URI sinkron dari cache, dan bila `enabled`
 * (tile gambar) materialisasi dari Telegram di latar belakang lalu perbarui
 * state sehingga gambar muncul setelah unduhan selesai.
 */
export function usePreviewUri(file: FileRow | null, token: string | null, enabled = true): string {
  const [uri, setUri] = useState(() => (file ? fileDownloadUrl(file, token) : ''));
  const fileId = file?.id;
  useEffect(() => {
    if (fileId == null || !enabled || isWeb) return;
    let alive = true;
    const cached = getPreviewUri(fileId);
    if (cached) {
      // Microtask agar tidak memanggil setState sinkron di dalam effect
      // (react-hooks/set-state-in-effect) — cache sudah ada, cukup satu tick.
      void Promise.resolve(cached).then((u) => {
        if (alive) setUri(u);
      });
      return;
    }
    void materializePreview(fileId)
      .then((u) => {
        if (alive) setUri(u);
      })
      .catch(() => {
        /* unduhan gagal — biarkan kosong (komponen jatuh ke glyph via onError) */
      });
    return () => {
      alive = false;
    };
  }, [fileId, token, enabled]);
  return uri;
}

/**
 * Unduh file ke perangkat. Web: navigate ke URL (server kirim attachment).
 * Native: materialize dari Telegram → pilih folder tujuan (SAF) → tulis base64.
 */
export async function downloadFile(token: string | null, file: FileRow): Promise<void> {
  if (isWeb) {
    const url = fileDownloadUrl(file, token);
    (globalThis as unknown as { location: { href: string } }).location.href = url;
    return;
  }
  const SAF = FileSystem.StorageAccessFramework;
  const perm = await SAF.requestDirectoryPermissionsAsync();
  if (!perm.granted) throw new ApiError(0, 'PERMISSION_DENIED');
  const { path, mime, name } = await materializeFile(file.id);
  try {
    const b64 = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 });
    const destUri = await SAF.createFileAsync(perm.directoryUri, name, mime);
    await FileSystem.writeAsStringAsync(destUri, b64, { encoding: FileSystem.EncodingType.Base64 });
  } finally {
    await FileSystem.deleteAsync(path, { idempotent: true }).catch(() => undefined);
  }
}

export const Api = {
  startAuth: (apiId: number, apiHash: string, phone: string, token: string | null) =>
    api<{ requestId: string }>('/auth/start', { body: { apiId, apiHash, phone }, token }),
  verify: (requestId: string, code: string, token: string | null) =>
    api<{ status?: string; token?: string; refreshToken?: string; me?: unknown; session?: string; apiId?: number; apiHash?: string }>('/auth/verify', { body: { requestId, code }, token, _canRefresh: false }),
  password: (requestId: string, password: string, token: string | null) =>
    api<{ token: string; refreshToken?: string; me?: unknown; session?: string; apiId?: number; apiHash?: string }>('/auth/password', { body: { requestId, password }, token, _canRefresh: false }),
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
      const blob = await (await fetch(file.uri)).blob();
      form.append('file', blob, file.name);
    } else {
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
    }
    const q = clientUploadId ? `?clientUploadId=${encodeURIComponent(clientUploadId)}` : '';
    return api<{ file: FileRow; deduped?: boolean }>(`/files${q}`, { token, formData: form });
  },

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

  stats: (token: string | null) => api<StatsResult>('/stats', { token }),
  activity: (token: string | null, limit = 50) =>
    api<{ activity: ActivityRow[] }>(`/activity?limit=${limit}`, { token }),

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

  devices: (token: string | null) => api<{ devices: DeviceRow[] }>('/devices', { token }),
  removeDevice: (token: string | null, id: number) =>
    api<{ ok: boolean }>(`/devices/${id}`, { method: 'DELETE', token }),
  refresh: (refreshToken: string) =>
    api<{ token: string; refreshToken: string }>('/auth/refresh', { body: { refreshToken } }),

  createPairing: (deviceLabel = 'Web') =>
    api<{ code: string; expiresIn: number }>('/auth/pairing', { body: { deviceLabel }, _canRefresh: false }),
  pollPairing: (code: string) =>
    api<{ status: 'pending' | 'approved' | 'redeemed' }>(`/auth/pairing/${code}`, { _canRefresh: false }),
  claimPairing: (code: string) =>
    api<{ token: string; refreshToken: string }>(`/auth/pairing/${code}/claim`, { method: 'POST', _canRefresh: false }),
  approvePairing: (token: string | null, code: string) =>
    api<{ ok: boolean }>(`/auth/pairing/${code}/approve`, { method: 'POST', token }),

  waStatus: (token: string | null) => api<WaStatus>('/wa/status', { token }),
  waConnect: (token: string | null) => api<WaStatus>('/wa/connect', { method: 'POST', token }),
  waDisconnect: (token: string | null) => api<WaStatus>('/wa/disconnect', { method: 'POST', token }),
};
