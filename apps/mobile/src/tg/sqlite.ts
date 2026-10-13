import { openDatabaseSync } from 'expo-sqlite';

/**
 * Adapter mini di atas expo-sqlite (API sync) dengan permukaan yang cocok dengan
 * subset better-sqlite3 yang dipakai server/src/db.ts. Tujuannya: db.ts bisa dip
 * nyaris verbatim tanpa diubah menjadi async total.
 *
 * Subset yang ditopang (semua dipakai db.ts):
 *   - new Database(path)
 *   - db.pragma('journal_mode = WAL') / db.pragma('user_version', { simple: true })
 *   - db.exec(sql)              — multi-statement
 *   - db.transaction(fn)        — commit/rollback otomatis, nestable
 *   - db.prepare(sql).get/run/all — tanpa argumen, posisional variadik, atau
 *                                   objek named (@x / $x / :x)
 *
 * Ketidakcocokan yang disamarkan di sini:
 *   - better-sqlite3 .all(params) menerima objek; expo-sqlite memisah bind
 *     primitif vs blob, lalu menentukan array-vs-object lewat argumen terpisah.
 *   - better-sqlite3 .run() mengembalikan { changes, lastInsertRowid } (kecil);
 *     expo-sqlite mengembalikan { changes, lastInsertRowId } (besar) sekaligus
 *     objek iterator hasil yang harus di-finalize agar tidak bocor statement.
 */

/** Tipe DB yang beredar di seluruh port — identik dengan `Database` better-sqlite3. */
export type Db = Database;

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

type NamedParams = Record<string, unknown>;

function isNamedParams(v: unknown): v is NamedParams {
  return (
    typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array) && !(v instanceof ArrayBuffer)
  );
}

/**
 * Pecah binding campuran (posisional/variadik/named/tanpa-argumen) menjadi
 * (paramsUntukExpo, haruskahLewatSebagaiArray) yang dipahami expo-sqlite.
 */
function toBindArgs(args: unknown[]): [Record<string, unknown> | unknown[], boolean] {
  if (args.length === 0) return [{}, false];
  if (args.length === 1) {
    const a = args[0];
    if (isNamedParams(a)) return [a, false];
    if (Array.isArray(a)) return [a as unknown[], true];
    return [{ 0: a } as Record<string, unknown>, false];
  }
  // Variadik posisional: .all(a, b, c) — salin apa adanya.
  return [args as unknown[], true];
}

export class Statement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
  ) {}

  /** Jalankan statement; finalisasi cursor hasil agar statement siap dipakai ulang. */
  private exec(args: unknown[]): { changes: number; lastInsertRowid: number | bigint; rows?: unknown[] } {
    const [params, asArray] = toBindArgs(args);
    const res = (this.db.native as { prepareSync(s: string): unknown }).prepareSync(this.sql) as unknown as {
      executeSync(p: unknown, a: boolean): {
        changes: number;
        lastInsertRowId: number;
        getAllSync(): unknown[];
      };
    };
    try {
      const exec = res.executeSync(params, asArray);
      let rows: unknown[] = [];
      try {
        rows = exec.getAllSync();
      } catch {
        /* INSERT/UPDATE tanpa RETURNING: tidak ada baris hasil — abaikan. */
      }
      return { changes: exec.changes, lastInsertRowid: exec.lastInsertRowId, rows };
    } finally {
      try {
        (res as unknown as { finalizeSync(): void }).finalizeSync();
      } catch {
        /* statement mungkin sudah finalisasi otomatis — abaikan */
      }
    }
  }

  get(...args: unknown[]): unknown {
    const { rows } = this.exec(args);
    return rows && rows.length > 0 ? rows[0] : undefined;
  }

  all(...args: unknown[]): unknown[] {
    const { rows } = this.exec(args);
    return rows ?? [];
  }

  run(...args: unknown[]): RunResult {
    const { changes, lastInsertRowid } = this.exec(args);
    return { changes, lastInsertRowid };
  }
}

export class Database {
  private txDepth = 0;
  private readonly raw: unknown;

  constructor(path: string) {
    this.raw = openDatabaseSync(path);
  }

  /** Akses objek expo-sqlite asli (untuk kebutuhan khusus di luar adapter). */
  get native(): unknown {
    return this.raw;
  }

  exec(sql: string): void {
    (this.raw as { execSync(s: string): void }).execSync(sql);
  }

  pragma(source: string, opts?: { simple?: boolean }): unknown {
    const sql = `PRAGMA ${source}`;
    const r = (this.raw as { prepareSync(s: string): unknown }).prepareSync(sql) as unknown as {
      executeSync(p: unknown, a: boolean): { getAllSync(): unknown[] };
      finalizeSync(): void;
    };
    try {
      const exec = r.executeSync({}, false);
      const rows = exec.getAllSync();
      if (opts?.simple) {
        // PRAGMA tunggal-kolom: ambil nilai kolom pertama baris pertama.
        const first = rows[0] as Record<string, unknown> | undefined;
        if (!first) return undefined;
        const keys = Object.keys(first);
        return keys.length > 0 ? first[keys[0]!] : undefined;
      }
      return rows;
    } finally {
      try {
        r.finalizeSync();
      } catch {
        /* noop */
      }
    }
  }

  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }

  /** Transaksi sinkron nestable — commit saat kedalaman kembali ke 0, rollback saat error. */
  transaction<T extends (...args: never[]) => unknown>(fn: T): T {
    // better-sqlite3: transaction(fn) mengembalikan fungsi yang memanggil fn.
    const db = this;
    return function (this: unknown, ...args: never[]) {
      const depth = db.txDepth;
      const begin = () => db.exec('BEGIN');
      const commit = () => db.exec('COMMIT');
      const rollback = () => db.exec('ROLLBACK');
      if (depth === 0) begin();
      db.txDepth = depth + 1;
      try {
        const out = fn.apply(this, args);
        db.txDepth = depth;
        if (depth === 0) commit();
        return out;
      } catch (err) {
        db.txDepth = depth;
        if (depth === 0) {
          try {
            rollback();
          } catch {
            /* transaksi mungkin sudah gagal sendiri */
          }
        }
        throw err;
      }
    } as T;
  }
}
