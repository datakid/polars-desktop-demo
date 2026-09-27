(function () {
  const PQ = self.PQ;
  const T = self.__TAURI__;
  const native = !!(T && T.core && T.core.invoke);
  const ua = navigator.userAgent || '';
  const inFrame = (() => { try { return self !== top; } catch (e) { return true; } })();
  const fsa = !native && !inFrame && typeof self.showOpenFilePicker === 'function';
  const P = (PQ.Platform = {
    native,
    fsa,
    os: /Mac|iPhone|iPad|iPod/i.test(ua) ? 'mac' : /Win/i.test(ua) ? 'windows' : 'linux',
    touch: typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches,
    info: { name: PQ.BRAND.name, version: '0.3.0', nativeEngine: false },
  });
  const inv = (cmd, args, opts) => T.core.invoke(cmd, args, opts);
  const toBuf = (x) => (x instanceof ArrayBuffer ? x : ArrayBuffer.isView(x) ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : new Uint8Array(x).buffer);
  const DATA_EXT = ['csv', 'tsv', 'txt', 'xlsx', 'xlsm', 'xlsb', 'xls', 'ods', 'json', 'ndjson', 'jsonl'];
  const DATA_ACCEPT = DATA_EXT.map((e) => '.' + e).join(',');
  const DATA_RE = new RegExp('\\.(' + DATA_EXT.join('|') + ')$', 'i');
  const PICK_DATA = [{
    description: 'Data files',
    accept: {
      'text/csv': ['.csv', '.tsv', '.txt'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx', '.xlsm', '.xlsb'],
      'application/vnd.ms-excel': ['.xls'],
      'application/vnd.oasis.opendocument.spreadsheet': ['.ods'],
      'application/json': ['.json', '.ndjson', '.jsonl'],
    },
  }];
  const PICK_PROJECT = [{ description: PQ.BRAND.name + ' project', accept: { 'application/json': ['.' + PQ.BRAND.ext, '.json'] } }];
  const SAVE_PROJECT = [{ description: PQ.BRAND.name + ' project', accept: { 'application/json': ['.' + PQ.BRAND.ext] } }];
  P.isData = (name) => DATA_RE.test(String(name || ''));
  P.isProject = (name) => /\.(floe|pqproj)$/i.test(String(name || ''));
  const aborted = (e) => !!e && e.name === 'AbortError';

  const kv = {
    p: null,
    open() {
      if (!this.p) this.p = new Promise((res, rej) => {
        const r = indexedDB.open('floe-web', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this.p;
    },
    async run(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('kv', mode);
        const req = fn(t.objectStore('kv'));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onerror = () => rej(t.error);
      });
    },
    get(k) { return this.run('readonly', (s) => s.get(k)).catch(() => undefined); },
    set(k, v) { return this.run('readwrite', (s) => s.put(v, k)).catch(() => {}); },
    del(k) { return this.run('readwrite', (s) => s.delete(k)).catch(() => {}); },
  };
  P.kv = kv;

  async function allow(handle, mode, ask) {
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    const o = { mode: mode || 'read' };
    try {
      if ((await handle.queryPermission(o)) === 'granted') return true;
      if (!ask) return false;
      return (await handle.requestPermission(o)) === 'granted';
    } catch (e) { return false; }
  }
  P.allow = allow;

  async function readAll(metas) {
    const out = [];
    for (const m of metas || []) out.push(Object.assign({}, m, { buf: toBuf(await inv('read_file', { path: m.path })) }));
    return out;
  }
  async function fromFileObjects(files, folder) {
    return Promise.all([...files].map(async (f) => ({ name: f.name, size: f.size, mtime: f.lastModified || Date.now(), folder: folder || '', path: null, handle: null, buf: await f.arrayBuffer() })));
  }
  async function fromHandle(h, folder) {
    const f = await h.getFile();
    return { name: f.name, size: f.size, mtime: f.lastModified || Date.now(), folder: folder || '', path: null, handle: h, buf: await f.arrayBuffer() };
  }
  async function walk(dir, folder, out, depth) {
    for await (const [name, h] of dir.entries()) {
      if (out.length >= 5000) return;
      if (h.kind === 'file' && DATA_RE.test(name)) out.push(await fromHandle(h, folder));
      else if (h.kind === 'directory' && depth < 4 && !name.startsWith('.')) await walk(h, folder, out, depth + 1);
    }
  }
  const pickBrowser = (accept, multiple, dir) => new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept || ''; inp.multiple = !!multiple; if (dir) inp.webkitdirectory = true;
    inp.style.display = 'none';
    const done = (files) => { res(files); inp.remove(); };
    inp.addEventListener('change', () => done([...inp.files]));
    inp.addEventListener('cancel', () => done([]));
    document.body.appendChild(inp); inp.click();
  });

  P.pickDataFiles = async function () {
    if (native) return readAll(await inv('pick_files', { kind: 'data', multiple: true }));
    if (fsa) {
      try { const hs = await showOpenFilePicker({ id: 'floe-data', multiple: true, types: PICK_DATA }); return Promise.all(hs.map((h) => fromHandle(h))); }
      catch (e) { if (aborted(e)) return []; throw e; }
    }
    return fromFileObjects(await pickBrowser(DATA_ACCEPT, true));
  };
  P.pickFolder = async function () {
    if (native) {
      const r = await inv('pick_folder');
      if (!r) return null;
      return { folder: r.folder, files: await readAll(r.files) };
    }
    if (fsa && typeof self.showDirectoryPicker === 'function') {
      let dir;
      try { dir = await showDirectoryPicker({ id: 'floe-folder', mode: 'read' }); }
      catch (e) { if (aborted(e)) return null; throw e; }
      const files = [];
      await walk(dir, dir.name, files, 0);
      files.sort((a, b) => a.name.localeCompare(b.name));
      return files.length ? { folder: dir.name, files } : null;
    }
    const files = (await pickBrowser('', true, true)).filter((f) => DATA_RE.test(f.name));
    if (!files.length) return null;
    const folder = (files[0].webkitRelativePath || 'folder').split('/')[0];
    return { folder, files: await fromFileObjects(files, folder) };
  };
  P.pickOneDataFile = async function () {
    if (native) return (await readAll(await inv('pick_files', { kind: 'data', multiple: false })))[0] || null;
    if (fsa) {
      try { const [h] = await showOpenFilePicker({ id: 'floe-data', multiple: false, types: PICK_DATA }); return h ? fromHandle(h) : null; }
      catch (e) { if (aborted(e)) return null; throw e; }
    }
    return (await fromFileObjects(await pickBrowser(DATA_ACCEPT, false)))[0] || null;
  };
  P.openProjectFile = async function () {
    if (native) {
      const [m] = await inv('pick_files', { kind: 'project', multiple: false });
      if (!m) return null;
      const buf = toBuf(await inv('read_file', { path: m.path }));
      return { name: m.name, path: m.path, text: new TextDecoder().decode(buf) };
    }
    if (fsa) {
      try {
        const [h] = await showOpenFilePicker({ id: 'floe-project', multiple: false, types: PICK_PROJECT });
        if (!h) return null;
        const f = await h.getFile();
        return { name: f.name, path: null, handle: h, text: await f.text() };
      } catch (e) { if (aborted(e)) return null; throw e; }
    }
    const [f] = await pickBrowser('.floe,.json,.pqproj', false);
    return f ? { name: f.name, path: null, handle: null, text: await f.text() } : null;
  };

  function download(name, bytes, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  const toBytes = (data) => (typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data);
  P.saveFile = async function (defaultName, data, mime) {
    const bytes = toBytes(data);
    if (native) {
      const path = await inv('pick_save', { defaultName });
      if (!path) return null;
      await inv('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
      return path;
    }
    download(defaultName, bytes, mime);
    return defaultName;
  };
  P.saveProject = async function (name, text, handle) {
    if (fsa) {
      let h = handle || null;
      if (h && !(await allow(h, 'readwrite', true))) h = null;
      if (!h) {
        try { h = await showSaveFilePicker({ id: 'floe-project', suggestedName: name, types: SAVE_PROJECT }); }
        catch (e) { if (aborted(e)) return null; throw e; }
      }
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return { name: h.name, handle: h };
    }
    download(name, toBytes(text), 'application/json');
    return { name, handle: null };
  };
  P.writePath = async function (path, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    await inv('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
    return path;
  };
  P.stat = (path) => (native && path ? inv('file_stat', { path }) : Promise.resolve(null));
  P.readPath = async (path) => toBuf(await inv('read_file', { path }));

  P.fileHandles = {
    set: (id, h) => (h ? kv.set('file:' + id, h) : Promise.resolve()),
    get: (id) => kv.get('file:' + id),
    del: (id) => kv.del('file:' + id),
  };
  P.readIfChanged = async function (handle, rec, ask) {
    if (!(await allow(handle, 'read', ask))) return null;
    const f = await handle.getFile();
    if (f.lastModified === rec.mtime && f.size === rec.size) return null;
    return { buf: await f.arrayBuffer(), mtime: f.lastModified || Date.now(), size: f.size };
  };

  P.recent = {
    async list() { return fsa ? (await kv.get('recent')) || [] : []; },
    async add(handle) {
      if (!fsa || !handle) return;
      const list = await P.recent.list();
      const out = [{ name: handle.name, handle, at: Date.now() }];
      for (const r of list) {
        if (out.length >= 8) break;
        let same = false;
        try { same = !!(r.handle && (await r.handle.isSameEntry(handle))); } catch (e) { same = false; }
        if (!same) out.push(r);
      }
      await kv.set('recent', out);
    },
    async remove(i) { const list = await P.recent.list(); list.splice(i, 1); await kv.set('recent', list); },
    async open(r) {
      if (!(await allow(r.handle, 'read', true))) throw new Error('Permission to read ' + r.name + ' was not granted');
      const f = await r.handle.getFile();
      return { name: f.name, path: null, handle: r.handle, text: await f.text() };
    },
  };

  P.fromDrop = async function (dt) {
    const items = [...((dt && dt.items) || [])].filter((i) => i.kind === 'file');
    const handleP = items.map((i) => (fsa && typeof i.getAsFileSystemHandle === 'function' ? i.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null)));
    const fileObjs = items.map((i) => i.getAsFile());
    const handles = await Promise.all(handleP);
    const out = { project: null, files: [], skipped: [] };
    for (let k = 0; k < items.length; k++) {
      const h = handles[k], f = fileObjs[k];
      try {
        if (h && h.kind === 'directory') { const files = []; await walk(h, h.name, files, 0); out.files.push(...files); continue; }
        const file = f || (h ? await h.getFile() : null);
        if (!file) continue;
        const fh = h && h.kind === 'file' ? h : null;
        if (P.isProject(file.name)) { out.project = { name: file.name, path: null, handle: fh, text: await file.text() }; continue; }
        if (!DATA_RE.test(file.name)) { out.skipped.push(file.name); continue; }
        out.files.push({ name: file.name, size: file.size, mtime: file.lastModified || Date.now(), folder: '', path: null, handle: fh, buf: await file.arrayBuffer() });
      } catch (e) { out.skipped.push((f && f.name) || 'item'); }
    }
    return out;
  };

  P.copyText = async function (text) {
    try { if (navigator.clipboard && self.isSecureContext) { await navigator.clipboard.writeText(text); return true; } } catch (e) { }
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  };
  P.persist = async function () {
    try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) return await navigator.storage.persist(); } catch (e) { }
    return false;
  };
  P.storage = async function () {
    try {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage || 0, quota: e.quota || 0, persisted: navigator.storage.persisted ? await navigator.storage.persisted() : false };
    } catch (e) { return null; }
  };

  P.setTitle = function (title) {
    document.title = title;
    if (native && T.window && T.window.getCurrentWindow) T.window.getCurrentWindow().setTitle(title).catch(() => {});
  };
  P.onMenu = function (fn) { if (native) T.event.listen('floe://menu', (e) => fn(e.payload)); };
  P.onFilesDropped = function (fn) {
    if (!native) return;
    T.event.listen('floe://files-dropped', async (e) => { document.body.classList.remove('dragging'); fn(await readAll(e.payload)); });
    T.event.listen('tauri://drag-enter', () => document.body.classList.add('dragging'));
    T.event.listen('tauri://drag-leave', () => document.body.classList.remove('dragging'));
  };
  P.onOpenProject = function (fn, onData) {
    if (native) {
      const load = async (m) => { if (!m) return; const buf = toBuf(await inv('read_file', { path: m.path })); fn({ name: m.name, path: m.path, text: new TextDecoder().decode(buf) }); };
      inv('take_launch_file').then(load).catch(() => {});
      T.event.listen('floe://open-project', (e) => load(e.payload));
      return;
    }
    if (!self.launchQueue || typeof self.launchQueue.setConsumer !== 'function') return;
    self.launchQueue.setConsumer(async (params) => {
      const hs = (params && params.files) || [];
      if (!hs.length) return;
      try {
        const proj = hs.find((h) => h.kind === 'file' && P.isProject(h.name));
        if (proj) { const f = await proj.getFile(); fn({ name: f.name, path: null, handle: proj, text: await f.text() }); }
        const data = hs.filter((h) => h.kind === 'file' && DATA_RE.test(h.name));
        if (data.length && onData) onData(await Promise.all(data.map((h) => fromHandle(h))));
      } catch (e) { console.warn('launch files failed', e); }
    });
  };
  P.init = async function () {
    document.body.classList.add(native ? 'native' : 'web', 'os-' + P.os);
    if (fsa) document.body.classList.add('fsa');
    if (P.touch) document.body.classList.add('touch');
    if (native) { try { P.info = Object.assign(P.info, await inv('app_info')); } catch (e) { } return; }
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
      navigator.serviceWorker.register('sw.js').then((reg) => { P.sw = reg; }).catch(() => {});
    }
  };
  P.kbd = (s) => (!s ? s : P.os === 'mac' ? s.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥') : s);
  P.menuOwns = (e) => native && (e.ctrlKey || e.metaKey) && ['n', 'o', 's', 'e', ','].includes(e.key.toLowerCase()) || (native && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') || (native && e.key === 'F5');
})();
