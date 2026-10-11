import type { FastifyReply } from 'fastify';

/**
 * Hub SSE (Server-Sent Events) sederhana in-process.
 *
 * Kenapa SSE bukan WebSocket: yang dibutuhkan hanya push server→client realtime
 * (file baru, status WhatsApp, sinkron selesai). SSE jalan di atas HTTP biasi,
 * EventSource di browser menangani reconnect otomatis, dan tidak butuh upgrade
 * protokol. Cukup untuk personal-use skala kecil.
 *
 * Catatan: mobile (React Native) fetch tidak mendukung stream body dengan baik,
 * jadi app native memakai polling /activity sebagai fallback. SSE dipakai web.
 */
export class SseHub {
  private clients = new Set<FastifyReply>();

  /** Daftarkan satu klien. Mengembalikan fungsi batal berlangganan. */
  subscribe(reply: FastifyReply): () => void {
    this.clients.add(reply);
    return () => this.clients.delete(reply);
  }

  get size(): number {
    return this.clients.size;
  }

  /** Kirim event ke semua klien. `id` dipakai Last-Event-ID untuk resume. */
  broadcast(type: string, data: unknown, id?: number): void {
    const payload = `event: ${type}\n` +
      (id != null ? `id: ${id}\n` : '') +
      `data: ${JSON.stringify(data)}\n\n`;
    for (const reply of this.clients) {
      try {
        reply.raw.write(payload);
      } catch {
        // klien mati — buang diam-diam
        this.clients.delete(reply);
      }
    }
  }

  /** Tutup semua koneksi (dipanggil saat server shutdown). */
  closeAll(): void {
    for (const reply of this.clients) {
      try { reply.raw.end(); } catch { /* abaikan */ }
    }
    this.clients.clear();
  }
}
