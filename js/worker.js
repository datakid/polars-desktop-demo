/* Engine worker entry point — the in-app engine process.
 * Cancel = terminate this worker; a crash here never takes down the UI; the supervisor restarts it.
 * All libraries are bundled locally so the desktop app works offline. */
/* global importScripts */
importScripts(
  '../vendor/xlsx.full.min.js',
  '../vendor/alasql.min.js',
  'util.js', 'expr.js', 'io.js', 'steps.js', 'engine.js', 'host.js'
);

self.onmessage = async (ev) => {
  const msg = ev.data;
  const progress = (p) => self.postMessage({ id: msg.id, type: 'progress', payload: p });
  try {
    const payload = await self.PQ.Host.handle(msg, progress);
    const transfer = payload && payload.data instanceof ArrayBuffer ? [payload.data] : [];
    self.postMessage({ id: msg.id, type: 'done', payload }, transfer);
  } catch (e) {
    self.postMessage({ id: msg.id, type: 'error', payload: { message: e && e.message ? e.message : String(e), stack: e && e.stack } });
  }
};
self.postMessage({ type: 'ready' });
