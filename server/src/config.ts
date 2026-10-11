import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().default(8787),
  TURNO_SECRET_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  JWT_SECRET: z.string().min(32).optional(),
  SHEETS_WEBHOOK_URL: z.string().url().optional().or(z.literal('')).default(''),
  SHEETS_TOKEN: z.string().optional().default(''),
  SHEET_SYNC_INTERVAL_MS: z.coerce.number().default(30_000),
  MAX_FILE_BYTES: z.coerce.number().default(2 * 1024 * 1024 * 1024),
  DB_PATH: z.string().default('./data/telegram-drive.sqlite'),
});

export type AppConfig = z.infer<typeof EnvSchema>;

/** Hasilkan secret di .env: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cfg = EnvSchema.parse(env);
  if (!cfg.TURNO_SECRET_KEY) {
    throw new Error('TURNO_SECRET_KEY wajib diisi (64 karakter hex) — lihat .env.example');
  }
  if (!cfg.JWT_SECRET) {
    throw new Error('JWT_SECRET wajib diisi (min 32 karakter) — lihat .env.example');
  }
  return cfg;
}
