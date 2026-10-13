/** Stub node-localstorage (dipakai StoreSession — TIDAK dipakai; app memakai StringSession). */
class LocalStorage {
  constructor() { throw new Error('node-localstorage tidak tersedia di RN — pakai StringSession'); }
}
module.exports = { LocalStorage };
