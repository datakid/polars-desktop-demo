(function () {
  const PQ = self.PQ;
  const IDB = PQ.IDB;
  const raw = { put: IDB.put.bind(IDB), all: IDB.all.bind(IDB), del: IDB.del.bind(IDB), clear: IDB.clear.bind(IDB) };
  let dirP = null;
  PQ.storageBackend = 'indexeddb';

  function opfs() {
    if (dirP) return dirP;
    dirP = (async () => {
      try {
        if (!self.navigator || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;
        const root = await navigator.storage.getDirectory();
        const dir = await root.getDirectoryHandle('floe-files', { create: true });
        const probe = await dir.getFileHandle('.probe', { create: true });
        await writeHandle(probe, new Uint8Array([1]).buffer);
        await dir.removeEntry('.probe');
        PQ.storageBackend = 'opfs';
        return dir;
      } catch (e) { return null; }
    })();
    return dirP;
  }
  async function writeHandle(fh, buf) {
    if (typeof fh.createWritable === 'function') {
      const w = await fh.createWritable();
      await w.write(buf);
      await w.close();
      return;
    }
    if (typeof fh.createSyncAccessHandle === 'function') {
      const ah = await fh.createSyncAccessHandle();
      try { ah.truncate(0); ah.write(new Uint8Array(buf), { at: 0 }); ah.flush(); } finally { ah.close(); }
      return;
    }
    throw new Error('OPFS writes are not supported here');
  }
  const fname = (id) => 'f_' + String(id).replace(/[^\w-]/g, '_');

  IDB.put = async function (rec) {
    const dir = await opfs();
    if (!dir || !rec.buf) return raw.put(rec);
    try {
      await writeHandle(await dir.getFileHandle(fname(rec.id), { create: true }), rec.buf);
      return raw.put(Object.assign({}, rec, { buf: null, opfs: true }));
    } catch (e) { return raw.put(rec); }
  };
  IDB.all = async function () {
    const list = await raw.all();
    const dir = await opfs();
    const out = [];
    for (const rec of list) {
      if (rec.opfs) {
        if (!dir) continue;
        try { out.push(Object.assign({}, rec, { buf: await (await (await dir.getFileHandle(fname(rec.id))).getFile()).arrayBuffer() })); }
        catch (e) { console.warn('Missing OPFS data for ' + rec.name); }
        continue;
      }
      out.push(rec);
      if (dir && rec.buf) IDB.put(rec).catch(() => {});
    }
    return out;
  };
  IDB.del = async function (id) {
    const dir = await opfs();
    if (dir) { try { await dir.removeEntry(fname(id)); } catch (e) { } }
    return raw.del(id);
  };
  IDB.clear = async function () {
    const dir = await opfs();
    if (dir) { try { for await (const name of dir.keys()) await dir.removeEntry(name); } catch (e) { } }
    return raw.clear();
  };
})();
