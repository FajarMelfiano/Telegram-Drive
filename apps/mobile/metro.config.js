/* Metro config — alias modul Node.js → stub saat bundling teleproto untuk RN/web. */
const { getDefaultConfig } = require('expo/metro-config');

const path = require('path');
const config = getDefaultConfig(__dirname);

const STUB_DIR = path.resolve(__dirname, 'src/tg/stubs');

/** Modul Node yang dipakai teleproto tapi tidak relevan di RN (kita pakai WS + Buffer API). */
const STUBS = {
  fs: 'fs.js',
  os: 'os.js',
  path: 'path.js',
  net: 'net.js',
  tls: 'net.js',
  dns: 'net.js',
  zlib: 'zlib.js',
  crypto: 'crypto.js',
  http: 'net.js',
  https: 'net.js',
  child_process: 'net.js',
  'timers/promises': 'timers-promises.js',
  'node:timers/promises': 'timers-promises.js',
  'node-localstorage': 'node-localstorage.js',
  socks: 'socks.js',
};

const STUB_REQUESTS = new Set(Object.keys(STUBS));

config.resolver.sourceExts.push('cjs');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const bare = moduleName.startsWith('node:') ? moduleName.slice(5) : moduleName;
  if (STUB_REQUESTS.has(moduleName) || STUB_REQUESTS.has(bare)) {
    const file = STUBS[moduleName] ?? STUBS[bare];
    if (file) {
      return { type: 'sourceFile', filePath: path.join(STUB_DIR, file) };
    }
  }
  if (bare === 'events') {
    // events npm (implementasi EventEmitter murni JS) — disediakan Metro dari node_modules
    return context.resolveRequest(context, 'events', platform);
  }
  // Fallback: resolver default Metro (disediakan di context, tanpa rekursi)
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
