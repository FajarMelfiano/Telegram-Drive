/** Stub socks — hanya dipakai bila proxy SOCKS dikonfigurasi (tidak dipakai app ini). */
class SocksClient {
  static createConnection() {
    return Promise.reject(new Error('SOCKS proxy tidak tersedia di RN'));
  }
}
module.exports = { SocksClient, SocksProxy: class SocksProxy {} };
