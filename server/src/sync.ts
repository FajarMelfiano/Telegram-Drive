import { writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { Database } from 'better-sqlite3';
import { dequeueSyncBatch, markSynced, type FileRow } from './db.js';

export interface SyncConfig {
  SHEETS_WEBHOOK_URL: string;
  SHEETS_TOKEN: string;
  SHEET_SYNC_INTERVAL_MS: number;
}

export type FetchImpl = typeof fetch;

const BATCH_SIZE = 50;

function toSheetRows(files: FileRow[]): Array<Record<string, unknown>> {
  return files.map((f) => ({
    uid: f.fileUid,
    nama: f.name,
    ekstensi: f.ext ?? '',
    mime: f.mime ?? '',
    ukuran: f.size,
    kategori: f.categoryKey,
    channelId: f.channelId ?? '',
    messageId: f.messageId ?? '',
    tanggal: f.uploadedAt,
    status: f.state,
  }));
}

/**
 * Kirim satu batch antrean ke Google Sheets (Apps Script web app) lalu tandai synced.
 * Gagal → baris tetap di antrean (dicoba lagi tick berikutnya). Idempoten di sisi
 * Apps Script berdasarkan kolom uid.
 */
export async function syncOnce(
  db: Database,
  cfg: Pick<SyncConfig, 'SHEETS_WEBHOOK_URL' | 'SHEETS_TOKEN'>,
  fetchImpl: FetchImpl = fetch,
): Promise<{ sent: number; failed: boolean }> {
  const batch = dequeueSyncBatch(db, BATCH_SIZE);
  if (batch.length === 0) return { sent: 0, failed: false };
  if (!cfg.SHEETS_WEBHOOK_URL) return { sent: 0, failed: false }; // belum dikonfigurasi: tunggu

  try {
    const res = await fetchImpl(cfg.SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sheets-token': cfg.SHEETS_TOKEN },
      body: JSON.stringify({ rows: toSheetRows(batch) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { sent: 0, failed: true };
    for (const f of batch) markSynced(db, f.id);
    return { sent: batch.length, failed: false };
  } catch {
    return { sent: 0, failed: true };
  }
}

/** Bangun workbook manifest (dipakai endpoint /logs.xlsx). */
export async function buildXlsxBuffer(db: Database): Promise<Buffer> {
  const { listFiles } = await import('./db.js');
  const files = listFiles(db, { limit: 100_000 });
  return writeWorkbook(files);
}

function writeWorkbook(files: FileRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Telegram Drive';
  const ws = wb.addWorksheet('Manifest');
  ws.columns = [
    { header: 'UID', key: 'fileUid', width: 38 },
    { header: 'Nama', key: 'name', width: 42 },
    { header: 'Ekstensi', key: 'ext', width: 10 },
    { header: 'MIME', key: 'mime', width: 32 },
    { header: 'Ukuran (byte)', key: 'size', width: 14 },
    { header: 'Kategori', key: 'categoryKey', width: 12 },
    { header: 'Channel ID', key: 'channelId', width: 14 },
    { header: 'Message ID', key: 'messageId', width: 12 },
    { header: 'Tanggal Upload', key: 'uploadedAt', width: 24 },
    { header: 'Status', key: 'state', width: 10 },
  ];
  for (const f of files) ws.addRow(f);
  ws.getRow(1).font = { bold: true };
  return wb.xlsx.writeBuffer() as unknown as Promise<Buffer>;
}

/** Tulis file .xlsx rolling ke disk (cadangan lokal bila Sheets tidak tersedia). */
export async function writeRollingXlsx(db: Database, path: string): Promise<void> {
  const { listFiles } = await import('./db.js');
  const buffer = await writeWorkbook(listFiles(db, { limit: 100_000 }));
  await writeFile(path, buffer);
}

/** Jalankan sinkron berkala; kembalikan fungsi stop. */
export function startSyncWorker(
  db: Database,
  cfg: SyncConfig,
  fetchImpl: FetchImpl = fetch,
  onTick?: (r: { sent: number; failed: boolean }) => void,
): () => void {
  const timer = setInterval(() => {
    void syncOnce(db, cfg, fetchImpl).then((r) => onTick?.(r));
  }, cfg.SHEET_SYNC_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
