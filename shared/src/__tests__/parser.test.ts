import { describe, it, expect } from 'vitest';
import { parseQuery } from '../parser.js';

// Reference date tetap supaya test deterministik
const REF = new Date('2026-10-11T12:00:00Z');

describe('parseQuery', () => {
  it('extracts extension, text and month range (id)', () => {
    const q = parseQuery('pdf laporan juni', REF);
    expect(q.ext).toBe('pdf');
    expect(q.text).toBe('laporan');
    expect(q.dateFrom).toBe('2026-06-01T00:00:00.000Z');
    expect(q.dateTo).toBe('2026-06-30T23:59:59.999Z');
  });

  it('extracts extension with leading dot', () => {
    const q = parseQuery('.png foto liburan', REF);
    expect(q.ext).toBe('png');
    expect(q.text).toBe('foto liburan');
  });

  it('uses explicit year after month', () => {
    const q = parseQuery('juni 2025 laporan', REF);
    expect(q.dateFrom).toBe('2025-06-01T00:00:00.000Z');
    expect(q.dateTo).toBe('2025-06-30T23:59:59.999Z');
  });

  it('recognizes english month', () => {
    const q = parseQuery('report june 2025', REF);
    expect(q.dateFrom).toBe('2025-06-01T00:00:00.000Z');
    expect(q.text).toBe('report');
  });

  it('maps category keywords (id + en)', () => {
    expect(parseQuery('gambar bulan lalu', REF).category).toBe('gambar');
    expect(parseQuery('foto kemarin', REF).category).toBe('gambar');
    expect(parseQuery('dokumen penting', REF).category).toBe('dokumen');
    expect(parseQuery('video kemarin', REF).category).toBe('video');
    expect(parseQuery('lagu lama', REF).category).toBe('audio');
    expect(parseQuery('arsip backup', REF).category).toBe('arsip');
  });

  it('handles relative day phrases', () => {
    const today = parseQuery('kemarin', REF);
    expect(today.dateFrom).toBe('2026-10-10T00:00:00.000Z');
    expect(today.dateTo).toBe('2026-10-10T23:59:59.999Z');

    const en = parseQuery('yesterday invoice', REF);
    expect(en.dateFrom).toBe('2026-10-10T00:00:00.000Z');
    expect(en.text).toBe('invoice');
  });

  it('handles last week and last month ranges', () => {
    const week = parseQuery('minggu lalu', REF);
    expect(week.dateFrom).toBe('2026-10-04T00:00:00.000Z');
    expect(week.dateTo).toBe('2026-10-10T23:59:59.999Z');

    const month = parseQuery('bulan lalu', REF);
    expect(month.dateFrom).toBe('2026-09-01T00:00:00.000Z');
    expect(month.dateTo).toBe('2026-09-30T23:59:59.999Z');
  });

  it('parses min size operator', () => {
    const q = parseQuery('video >100mb', REF);
    expect(q.category).toBe('video');
    expect(q.minSize).toBe(100 * 1024 * 1024);
  });

  it('parses explicit ISO date and comparisons', () => {
    const exact = parseQuery('2025-06-15 foto', REF);
    expect(exact.dateFrom).toBe('2025-06-15T00:00:00.000Z');
    expect(exact.dateTo).toBe('2025-06-15T23:59:59.999Z');

    const after = parseQuery('>2025-06-01 pdf', REF);
    expect(after.dateFrom).toBe('2025-06-01T00:00:00.000Z');
    expect(after.ext).toBe('pdf');
  });

  it('deduplicates extensions', () => {
    const q = parseQuery('pdf .pdf laporan', REF);
    expect(q.ext).toBe('pdf');
    expect(q.text).toBe('pdf laporan');
  });

  it('returns empty result for empty input', () => {
    const q = parseQuery('', REF);
    expect(q).toEqual({
      text: '',
      ext: null,
      category: null,
      dateFrom: null,
      dateTo: null,
      minSize: null,
    });
  });

  it('never throws on weird input and passes text through', () => {
    const q = parseQuery('kata @@## aneh --;;', REF);
    expect(q.text).toContain('kata');
    expect(q.text).toContain('aneh');
  });
});
