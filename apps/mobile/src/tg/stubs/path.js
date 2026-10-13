/** Stub path (posix, cukup untuk teleproto: join/resolve/isAbsolute/basename/dirname/extname). */
const sep = '/';

function normalize(p) {
  const parts = String(p).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); }
    else out.push(part);
  }
  const abs = String(p).startsWith('/');
  return (abs ? '/' : '') + out.join(sep) || (abs ? '/' : '.');
}

module.exports = {
  sep,
  delimiter: ':',
  join: (...parts) => normalize(parts.filter((p) => p !== undefined && p !== null).join('/')),
  resolve: (...parts) => {
    let joined = parts.filter((p) => p !== undefined && p !== null).join('/');
    if (!joined.startsWith('/')) joined = '/' + joined;
    return normalize(joined);
  },
  isAbsolute: (p) => String(p).startsWith('/'),
  basename: (p, ext) => {
    const base = String(p).split('/').pop() ?? '';
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  dirname: (p) => {
    const s = String(p);
    const idx = s.lastIndexOf('/');
    if (idx <= 0) return idx === 0 ? '/' : '.';
    return s.slice(0, idx);
  },
  extname: (p) => {
    const base = String(p).split('/').pop() ?? '';
    const idx = base.lastIndexOf('.');
    return idx > 0 ? base.slice(idx) : '';
  },
};
