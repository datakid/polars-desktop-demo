/* global importScripts */
importScripts('util.js', 'storage.js', 'expr.js', 'io.js', 'steps.js', 'engine.js', 'host.js', 'engine-ext.js');

self.onmessage = async (ev) => {
  const msg = ev.data;
  const progress = (p) => self.postMessage({ id: msg.id, type: 'progress', payload: p });
  try {
    const payload = await self.PQ.Host.handle(msg, progress);
    const transfer = payload && payload.data instanceof ArrayBuffer ? [payload.data] : [];
    if (payload && Array.isArray(payload.outputs)) payload.outputs.forEach((o) => { if (o.data instanceof ArrayBuffer) transfer.push(o.data); });
    self.postMessage({ id: msg.id, type: 'done', payload }, transfer);
  } catch (e) {
    self.postMessage({ id: msg.id, type: 'error', payload: { message: e && e.message ? e.message : String(e), stack: e && e.stack } });
  }
};
self.postMessage({ type: 'ready' });
