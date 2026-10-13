/** Stub node:timers/promises — cukup untuk dispatch.js (delay sederhana). */
function nodeSetTimeout(delay, value, options) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), delay);
    const signal = options && options.signal;
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function nodeSetInterval(delay, value, options) {
  const signal = options && options.signal;
  let closed = false;
  const iterator = {
    [Symbol.asyncIterator]() { return iterator; },
    next() {
      if (closed) return Promise.resolve({ done: true, value: undefined });
      return new Promise((resolve) => {
        const timer = setInterval(() => resolve({ done: false, value }), delay);
        iterator._stop = () => { clearInterval(timer); };
        if (signal) signal.addEventListener('abort', () => { clearInterval(timer); closed = true; }, { once: true });
      });
    },
    return() { closed = true; if (iterator._stop) iterator._stop(); return Promise.resolve({ done: true, value: undefined }); },
    throw(e) { return Promise.reject(e); },
  };
  return iterator;
}

module.exports = {
  setTimeout: nodeSetTimeout,
  setInterval: nodeSetInterval,
  clearTimeout,
  clearInterval,
};
