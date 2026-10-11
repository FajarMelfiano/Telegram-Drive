import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { Api, ApiError } from './api';

/**
 * Antrian unggah tahan-hilang (Layer 1 — jaring pengaman).
 *
 * Sebelum unggah, file dicatat dulu ke penyimpanan lokal. Saat app dibuka lagi,
 * antrian diputar ulang otomatis. Metadata di AsyncStorage; isi file web disimpan
 * di IndexedDB agar bertahan setelah tab di-reload. Di native, sumber = berkas
 * hasil salinan DocumentPicker (copyToCacheDirectory) yang bertahan antar-launch.
 *
 * Tanpa batas percobaan (anti-hilang): entri tetap "queued" sampai sukses,
 * kecuali4xx validasi (gagal permanen) atau sumber hilang (source_lost).
 */

export type QueueState = 'queued' | 'uploading' | 'failed' | 'source_lost';

export interface QueueEntry {
  clientUploadId: string;
  name: string;
  size: number;
  mime: string;
  sourceKind: 'native-cache' | 'web-idb';
  sourceRef: string;
  state: QueueState;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

const KEY = 'td.uploadQueue';

let cache: QueueEntry[] | null = null;
let draining = false;

function generateId(): string {
  const g = globalThis.crypto as Crypto | undefined;
  if (g && typeof g.randomUUID === 'function') return g.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---- IndexedDB (web): simpan Blob file agar bertahan reload ----

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('td-upload', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key: string, blob: Blob): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(blob, key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

async function idbGet(key: string): Promise<Blob | undefined> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readonly');
    const req = tx.objectStore('files').get(key);
    req.onsuccess = () => { db.close(); resolve(req.result as Blob | undefined); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function idbDel(key: string): Promise<void> {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').delete(key);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

// ---- persistensi antrian ----

async function readAll(): Promise<QueueEntry[]> {
  if (cache) return cache;
  const raw = await AsyncStorage.getItem(KEY);
  let entries: QueueEntry[] = [];
  try { entries = raw ? (JSON.parse(raw) as QueueEntry[]) : []; } catch { entries = []; }
  // Crash recovery: entri yang tertinggal "uploading" (app dibunuh) → queued lagi.
  let changed = false;
  for (const e of entries) {
    if (e.state === 'uploading') { e.state = 'queued'; changed = true; }
  }
  cache = entries;
  if (changed) await AsyncStorage.setItem(KEY, JSON.stringify(entries));
  return entries;
}

async function persist(entries: QueueEntry[]): Promise<void> {
  cache = entries;
  await AsyncStorage.setItem(KEY, JSON.stringify(entries));
}

/** Daftar entri antrian saat ini (snapshot). */
export async function getQueue(): Promise<QueueEntry[]> {
  return [...(await readAll())];
}

export interface EnqueueInput {
  uri: string;
  name: string;
  type: string;
  size: number;
}

/** Catat file ke antrian SEBELUM unggah. Web: simpan Blob ke IndexedDB. */
export async function enqueueUpload(input: EnqueueInput): Promise<QueueEntry> {
  const clientUploadId = generateId();
  let sourceKind: QueueEntry['sourceKind'];
  let sourceRef: string;

  if (Platform.OS === 'web') {
    const blob = await (await fetch(input.uri)).blob();
    await idbPut(clientUploadId, blob);
    sourceKind = 'web-idb';
    sourceRef = clientUploadId;
  } else {
    // DocumentPicker(copyToCacheDirectory) menyalin ke cache → bertahan antar-launch.
    sourceKind = 'native-cache';
    sourceRef = input.uri;
  }

  const now = new Date().toISOString();
  const entry: QueueEntry = {
    clientUploadId, name: input.name, size: input.size, mime: input.type,
    sourceKind, sourceRef, state: 'queued', attempts: 0, createdAt: now, updatedAt: now,
  };
  const all = await readAll();
  all.push(entry);
  await persist(all);
  return entry;
}

/** Siapkan {uri,name,type} untuk unggah; null bila sumber tak ditemukan. */
async function resolveSource(entry: QueueEntry): Promise<{ uri: string; name: string; type: string } | null> {
  if (entry.sourceKind === 'web-idb') {
    const blob = await idbGet(entry.clientUploadId).catch(() => undefined);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { uri: url, name: entry.name, type: entry.mime };
  }
  try {
    const fs = await import('expo-file-system');
    const f = new fs.File(entry.sourceRef);
    if (!f.exists) return null;
  } catch {
    /* tak bisa cek → biarkan unggah mencoba; gagal jadi queued */
  }
  return { uri: entry.sourceRef, name: entry.name, type: entry.mime };
}

export interface DrainResult { uploaded: number; remaining: number }

/**
 * Putar antrian: proses snapshot "queued" sekali, berurutan 1 per waktu.
 * Gagal retryable → tetap queued (untuk drain berikutnya) — TANPA loop dalam sesi.
 */
export async function drainQueue(token: string | null, onUpdate?: () => void): Promise<DrainResult> {
  if (draining) {
    const cur = await readAll();
    return { uploaded: 0, remaining: cur.filter((e) => e.state === 'queued' || e.state === 'uploading').length };
  }
  draining = true;
  let uploaded = 0;
  try {
    const all = await readAll();
    const batch = all.filter((e) => e.state === 'queued');

    for (const entry of batch) {
      entry.state = 'uploading';
      entry.updatedAt = new Date().toISOString();
      await persist(all);
      onUpdate?.();

      const file = await resolveSource(entry);
      if (!file) {
        entry.state = 'source_lost';
        entry.lastError = 'Sumber file tak ditemukan — pilih ulang';
        entry.updatedAt = new Date().toISOString();
        await persist(all);
        onUpdate?.();
        continue;
      }

      try {
        await Api.upload(token, file, entry.clientUploadId);
        const idx = all.indexOf(entry);
        if (idx >= 0) all.splice(idx, 1); // sukses → keluar dari antrian
        await persist(all);
        onUpdate?.();
        uploaded++;
      } catch (err) {
        entry.attempts += 1;
        const permanent = err instanceof ApiError && err.status >= 400 && err.status < 500
          && err.status !== 401 && err.status !== 429;
        entry.state = permanent ? 'failed' : 'queued';
        entry.lastError = err instanceof ApiError ? err.code : 'NETWORK';
        entry.updatedAt = new Date().toISOString();
        await persist(all);
        onUpdate?.();
      }
    }
  } finally {
    draining = false;
  }
  const cur = await readAll();
  return { uploaded, remaining: cur.filter((e) => e.state === 'queued' || e.state === 'uploading').length };
}

/** Buang entri (batal / buang hasil gagal) + hapus blob web terkait. */
export async function removeUpload(clientUploadId: string): Promise<void> {
  const all = await readAll();
  const entry = all.find((e) => e.clientUploadId === clientUploadId);
  const idx = all.findIndex((e) => e.clientUploadId === clientUploadId);
  if (idx >= 0) { all.splice(idx, 1); await persist(all); }
  if (entry?.sourceKind === 'web-idb') await idbDel(clientUploadId).catch(() => undefined);
}

/** Tandai entri gagal/source_lost untuk dicoba lagi. */
export async function retryUpload(clientUploadId: string): Promise<void> {
  const all = await readAll();
  const entry = all.find((e) => e.clientUploadId === clientUploadId);
  if (entry) {
    entry.state = 'queued';
    entry.attempts = 0;
    entry.lastError = undefined;
    entry.updatedAt = new Date().toISOString();
    await persist(all);
  }
}
