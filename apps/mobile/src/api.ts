import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

/** Default: server lokal. Di Android emulator pakai 10.0.2.2, di web bebas. */
const DEFAULT_BASE = Platform.select({
  android: 'http://10.0.2.2:8787',
  default: 'http://localhost:8787',
});
export const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_BASE;

const TOKEN_KEY = 'td.jwt';

export async function getToken(): Promise<string | null> {
  return AsyncStorage.getItem(TOKEN_KEY);
}
export async function setToken(t: string): Promise<void> {
  await AsyncStorage.setItem(TOKEN_KEY, t);
}
export async function clearToken(): Promise<void> {
  await AsyncStorage.removeItem(TOKEN_KEY);
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
  const res = await fetch(`${API_BASE}${path}`, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: opts.signal });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new ApiError(res.status, json.error ?? 'UNKNOWN', json.retryAfterSeconds);
  }
  return json as T;
}

// ---- tipe respons (mencerminkan kontrak server) ----
export interface FileRow {
  id: number; fileUid: string; name: string; ext: string | null; mime: string | null;
  size: number; categoryId: number; categoryKey: string;
  channelId: number | null; messageId: number | null; uploadedAt: string; state: string;
}
export interface CategoryRow {
  id: number; key: string; label: string;
  channelId: number | null; channelTitle: string | null; state: string; fileCount: number;
}
export interface ParsedQuery {
  text: string; ext: string | null; category: string | null;
  dateFrom: string | null; dateTo: string | null; minSize: number | null;
}

// ---- aksi API ----
export const Api = {
  startAuth: (apiId: number, apiHash: string, phone: string, token: string | null) =>
    api<{ requestId: string }>('/auth/start', { body: { apiId, apiHash, phone }, token }),
  verify: (requestId: string, code: string, token: string | null) =>
    api<{ status?: string; token?: string; me?: unknown }>('/auth/verify', { body: { requestId, code }, token }),
  password: (requestId: string, password: string, token: string | null) =>
    api<{ token: string; me?: unknown }>('/auth/password', { body: { requestId, password }, token }),
  me: (token: string | null) =>
    api<{ me: { id: number; firstName: string; username?: string }; phone: string | null }>('/me', { token }),
  logout: (token: string | null) => api<{ ok: boolean }>('/auth/logout', { method: 'POST', token }),
  categories: (token: string | null) => api<{ categories: CategoryRow[] }>('/categories', { token }),
  files: (token: string | null, category?: string) =>
    api<{ files: FileRow[] }>(`/files?limit=200${category ? `&category=${encodeURIComponent(category)}` : ''}`, { token }),
  search: (token: string | null, q: string) =>
    api<{ parsed: ParsedQuery; results: FileRow[] }>(`/search?q=${encodeURIComponent(q)}`, { token }),
  syncStatus: (token: string | null) => api<{ pending: number; sent: number }>('/sync/status', { token }),
  upload: async (token: string | null, file: { uri: string; name: string; type: string }) => {
    const form = new FormData();
    if (Platform.OS === 'web') {
      // Web: uri adalah blob URL — ubah dulu jadi Blob agar ikut terkirim
      const blob = await (await fetch(file.uri)).blob();
      form.append('file', blob, file.name);
    } else {
      // React Native: objek {uri,name,type} adalah format bawaan FormData
      form.append('file', { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);
    }
    return api<{ file: FileRow }>('/files', { token, formData: form });
  },
};
