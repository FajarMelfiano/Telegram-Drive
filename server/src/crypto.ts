import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Enkripsi AES-256-GCM untuk session string & api_hash Telegram.
 * Format: iv.tag.ciphertext (base64url).
 */
export function encrypt(plaintext: string, hexKey: string): string {
  const key = keyFrom(hexKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`;
}

export function decrypt(payload: string, hexKey: string): string {
  const key = keyFrom(hexKey);
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('Payload enkripsi tidak valid');
  const [iv, tag, data] = parts as [string, string, string];
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

function keyFrom(hexKey: string): Buffer {
  if (!hexKey || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error('TURNO_SECRET_KEY harus 64 karakter hex (32 byte)');
  }
  return Buffer.from(hexKey, 'hex');
}
