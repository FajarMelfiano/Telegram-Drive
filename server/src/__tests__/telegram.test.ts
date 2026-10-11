import { describe, expect, it } from 'vitest';
import tp from 'teleproto';
import { mapTelegramError } from '../telegram';

/**
 * Guard anti-recurrence: sebelumnya mapTelegramError mencari kode underscore
 * ("API_ID_INVALID") di err.message — padahal teleproto 1.23 menulis pesan
 * human-readable ("API ID invalid.") dan menyimpan kode mentah di err.errorMessage.
 * Test ini memakai kelas error ASLI teleproto supaya kontraklibrary tetap terjaga.
 */
const req = { className: 'auth.SendCode' };

describe('mapTelegramError vs error nyata teleproto', () => {
  it('ApiIdInvalidError → API_INVALID (pesan human-readable tanpa underscore)', () => {
    const err = new tp.errors.ApiIdInvalidError({ request: req });
    expect(err.message).toContain('API ID invalid'); // membuktikan pesan TANPA underscore
    expect(mapTelegramError(err).code).toBe('API_INVALID');
  });

  it('FloodWaitError → FLOOD_WAIT dengan detik dari properti .seconds', () => {
    const err = new tp.errors.FloodWaitError({ capture: '5', request: req });
    expect(mapTelegramError(err)).toEqual({ code: 'FLOOD_WAIT', retryAfterSeconds: 5 });
  });

  it('PhoneNumberInvalidError → PHONE_NUMBER_INVALID', () => {
    const err = new tp.errors.PhoneNumberInvalidError({ request: req });
    expect(mapTelegramError(err).code).toBe('PHONE_NUMBER_INVALID');
  });

  it('PhoneCodeInvalidError → PHONE_CODE_INVALID', () => {
    const err = new tp.errors.PhoneCodeInvalidError({ request: req });
    expect(mapTelegramError(err).code).toBe('PHONE_CODE_INVALID');
  });

  it('PhoneCodeExpiredError → PHONE_CODE_INVALID', () => {
    const err = new tp.errors.PhoneCodeExpiredError({ request: req });
    expect(mapTelegramError(err).code).toBe('PHONE_CODE_INVALID');
  });

  it('SessionPasswordNeededError → SESSION_PASSWORD_NEEDED (dasar deteksi 2FA)', () => {
    const err = new tp.errors.SessionPasswordNeededError({ request: req });
    expect(mapTelegramError(err).code).toBe('SESSION_PASSWORD_NEEDED');
  });

  it('PasswordHashInvalidError → PASSWORD_INVALID', () => {
    const err = new tp.errors.PasswordHashInvalidError({ request: req });
    expect(mapTelegramError(err).code).toBe('PASSWORD_INVALID');
  });

  it('error jaringan polos → TELEGRAM_ERROR', () => {
    expect(mapTelegramError(new Error('connect ETIMEDOUT 149.154.167.91:443')).code).toBe('TELEGRAM_ERROR');
  });

  it('format lama (kode underscore langsung di message) tetap terpetakan', () => {
    expect(mapTelegramError(new Error('FLOOD_WAIT_30')).retryAfterSeconds).toBe(30);
    expect(mapTelegramError(new Error('API_ID_INVALID')).code).toBe('API_INVALID');
  });
});
