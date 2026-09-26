/* Floe platform bridge.
 * Inside the Tauri 2 desktop app (`window.__TAURI__`, enabled by app.withGlobalTauri) this uses native file dialogs,
 * reads/writes real files through Rust commands (raw bytes, no JSON), receives native-menu and OS drag-drop events,
 * and sets the window title. In a plain browser the same API falls back to <input type=file> and downloads.
 * Nothing else in the UI needs to know which one it is running in. */
(function () {
  const PQ = self.PQ;
  const T = self.__TAURI__;
  const native = !!(T && T.core && T.core.invoke);
  const ua = navigator.userAgent || '';
  const P = (PQ.Platform = {
    native,
    os: /Mac/i.test(ua) ? 'mac' : /Win/i.test(ua) ? 'windows' : 'linux',
    info: { name: PQ.BRAND.name, version: '0.2.0', nativeEngine: false },
  });
  const inv = (cmd, args, opts) => T.core.invoke(cmd, args, opts);
  const toBuf = (x) => (x instanceof ArrayBuffer ? x : ArrayBuffer.isView(x) ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : new Uint8Array(x).buffer);
  const DATA_ACCEPT = '.csv,.tsv,.txt,.xlsx,.xlsm,.xlsb,.xls,.ods,.json,.ndjson,.jsonl';

  /** Read file bytes for native metas {name, path, size, mtime}. */
  async function readAll(metas) {
    const out = [];
    for (const m of metas || []) out.push(Object.assign({}, m, { buf: toBuf(await inv('read_file', { path: m.path })) }));
    return out;
  }
  async function fromFileObjects(files, folder) {
    return Promise.all([...files].map(async (f) => ({ name: f.name, size: f.size, mtime: f.lastModified || Date.now(), folder: folder || '', path: null, buf: await f.arrayBuffer() })));
  }
  const pickBrowser = (accept, multiple, dir) => new Promise((res) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept || ''; inp.multiple = !!multiple; if (dir) inp.webkitdirectory = true;
    inp.style.display = 'none';
    inp.addEventListener('change', () => { res([...inp.files]); inp.remove(); });
    document.body.appendChild(inp); inp.click();
  });

  /** → [{name, size, mtime, path|null, buf}] */
  P.pickDataFiles = async function () {
    if (native) return readAll(await inv('pick_files', { kind: 'data', multiple: true }));
    return fromFileObjects(await pickBrowser(DATA_ACCEPT, true));
  };
  /** → {folder, files:[…with buf]} | null */
  P.pickFolder = async function () {
    if (native) {
      const r = await inv('pick_folder');
      if (!r) return null;
      return { folder: r.folder, files: await readAll(r.files) };
    }
    const files = (await pickBrowser('', true, true)).filter((f) => /\.(csv|tsv|txt|xlsx|xlsm|xls|ods|json|ndjson|jsonl)$/i.test(f.name));
    if (!files.length) return null;
    const folder = (files[0].webkitRelativePath || 'folder').split('/')[0];
    return { folder, files: await fromFileObjects(files, folder) };
  };
  /** Single file picker (e.g. relink). */
  P.pickOneDataFile = async function () {
    if (native) return (await readAll(await inv('pick_files', { kind: 'data', multiple: false })))[0] || null;
    return (await fromFileObjects(await pickBrowser(DATA_ACCEPT, false)))[0] || null;
  };
  /** Open a project file → {name, text, path} | null */
  P.openProjectFile = async function () {
    if (native) {
      const [m] = await inv('pick_files', { kind: 'project', multiple: false });
      if (!m) return null;
      const buf = toBuf(await inv('read_file', { path: m.path }));
      return { name: m.name, path: m.path, text: new TextDecoder().decode(buf) };
    }
    const [f] = await pickBrowser('.floe,.json,.pqproj', false);
    return f ? { name: f.name, path: null, text: await f.text() } : null;
  };
  /** Save bytes/text. Native: Save As dialog → path. Browser: download. Returns the saved name/path or null if cancelled. */
  P.saveFile = async function (defaultName, data, mime) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    if (native) {
      const path = await inv('pick_save', { defaultName });
      if (!path) return null;
      await inv('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
      return path;
    }
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = defaultName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return defaultName;
  };
  /** Write to a path the user already granted (e.g. Save for an opened project). */
  P.writePath = async function (path, data) {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
    await inv('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
    return path;
  };
  P.stat = (path) => (native && path ? inv('file_stat', { path }) : Promise.resolve(null));
  P.readPath = async (path) => toBuf(await inv('read_file', { path }));

  P.setTitle = function (title) {
    document.title = title;
    if (native && T.window && T.window.getCurrentWindow) T.window.getCurrentWindow().setTitle(title).catch(() => {});
  };
  /** Native menu → id string (see desktop/src-tauri/src/menu.rs). */
  P.onMenu = function (fn) { if (native) T.event.listen('floe://menu', (e) => fn(e.payload)); };
  /** OS file drop (paths are granted by Rust, then read here). */
  P.onFilesDropped = function (fn) {
    if (!native) return;
    T.event.listen('floe://files-dropped', async (e) => { document.body.classList.remove('dragging'); fn(await readAll(e.payload)); });
    T.event.listen('tauri://drag-enter', () => document.body.classList.add('dragging'));
    T.event.listen('tauri://drag-leave', () => document.body.classList.remove('dragging'));
  };
  /** Project opened by file association / CLI arg / dropping a .floe file → fn({name, path, text}). */
  P.onOpenProject = function (fn) {
    if (!native) return;
    const load = async (m) => { if (!m) return; const buf = toBuf(await inv('read_file', { path: m.path })); fn({ name: m.name, path: m.path, text: new TextDecoder().decode(buf) }); };
    inv('take_launch_file').then(load).catch(() => {});
    T.event.listen('floe://open-project', (e) => load(e.payload));
  };
  P.init = async function () {
    document.body.classList.add(native ? 'native' : 'web', 'os-' + P.os);
    if (native) { try { P.info = Object.assign(P.info, await inv('app_info')); } catch (e) { /* older shell */ } }
  };
  /** Shortcuts owned by the native menu (so the web keyboard handler doesn't fire them twice). */
  P.menuOwns = (e) => native && (e.ctrlKey || e.metaKey) && ['n', 'o', 's', 'e', ','].includes(e.key.toLowerCase()) || (native && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') || (native && e.key === 'F5');
})();
