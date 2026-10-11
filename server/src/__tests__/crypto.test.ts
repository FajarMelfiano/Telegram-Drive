import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../crypto.js';

const KEY = 'a'.repeat(64); // 32 byte hex

describe('encrypt/decrypt', () => {
  it('roundtrips', () => {
    const enc = encrypt('session-rahasia-123', KEY);
    expect(enc).not.toContain('session-rahasia-123');
    expect(decrypt(enc, KEY)).toBe('session-rahasia-123');
  });

  it('produces different ciphertext each time (random IV)', () => {
    expect(encrypt('x', KEY)).not.toBe(encrypt('x', KEY));
  });

  it('fails on wrong key', () => {
    const enc = encrypt('y', KEY);
    expect(() => decrypt(enc, 'b'.repeat(64))).toThrow();
  });

  it('fails on tampered payload', () => {
    const enc = encrypt('z', KEY);
    const [iv, tag, data] = enc.split('.');
    expect(() => decrypt([iv, tag, data + 'AA'].join('.'), KEY)).toThrow();
  });
});
