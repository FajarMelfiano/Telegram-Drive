import { describe, it, expect } from 'vitest';
import { classifyFile } from '../classify.js';

describe('classifyFile', () => {
  it('maps image mime to gambar', () => {
    expect(classifyFile('image/jpeg', 'foto.jpg').category).toBe('gambar');
    expect(classifyFile('image/webp', 'sticker.webp').category).toBe('gambar');
  });

  it('maps pdf mime to dokumen', () => {
    expect(classifyFile('application/pdf', 'laporan.pdf').category).toBe('dokumen');
  });

  it('maps office openxml mimes to dokumen', () => {
    expect(
      classifyFile('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx').category,
    ).toBe('dokumen');
    expect(
      classifyFile('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'b.xlsx').category,
    ).toBe('dokumen');
  });

  it('maps video and audio mimes', () => {
    expect(classifyFile('video/mp4', 'clip.mp4').category).toBe('video');
    expect(classifyFile('audio/mpeg', 'song.mp3').category).toBe('audio');
  });

  it('maps archive mimes to arsip', () => {
    expect(classifyFile('application/zip', 'backup.zip').category).toBe('arsip');
    expect(classifyFile('application/x-rar-compressed', 'old.rar').category).toBe('arsip');
  });

  it('falls back to extension when mime is unknown', () => {
    expect(classifyFile('application/octet-stream', 'notes.docx').category).toBe('dokumen');
    expect(classifyFile('application/octet-stream', 'Photo.JPEG').category).toBe('gambar');
  });

  it('prefers mime over extension', () => {
    expect(classifyFile('image/png', '伪装.pdf').category).toBe('gambar');
  });

  it('returns lainnya when nothing matches', () => {
    expect(classifyFile('application/octet-stream', 'mystery.xyz').category).toBe('lainnya');
    expect(classifyFile('', '').category).toBe('lainnya');
  });
});
