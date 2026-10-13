/**
 * Stub net/tls/dns/http/https/child_process — TIDAK terpakai karena koneksi
 * memakai PromisedWebSockets (transport resmi WebSocket MTProto).
 */
function unused(name) {
  return () => { throw new Error(`node:${name} tidak tersedia di RN — koneksi wajib lewat PromisedWebSockets`); }
}

class Socket {
  constructor() { throw new Error('net.Socket tidak tersedia di RN — pakai WebSocket transport'); }
}

module.exports = {
  Socket,
  createConnection: unused('net.createConnection'),
  connect: unused('net.connect'),
  createServer: unused('net.createServer'),
  request: unused('http.request'),
  get: unused('http.get'),
  Agent: class Agent {},
  Server: class Server {},
  globals: {},
};
