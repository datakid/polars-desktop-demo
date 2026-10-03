/* PQX I/O — CSV sniffing/parsing, Excel navigator + reader (mirrors crates pq-connectors / pq-excel),
 * sample-data generation and output writers. Runs inside the engine worker. Uses SheetJS (global XLSX)
 * as the stand-in for calamine / rust_xlsxwriter. */
(function () {
  const PQ = self.PQ;
  const { Table, CellError } = PQ;
  const IO = (PQ.IO = {});

  /* ============================== Text decoding ============================== */
  IO.decode = function (buf, encoding) {
    const u8 = new Uint8Array(buf);
    if (!encoding || encoding === 'auto') {
      if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8-bom' };
      if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
      if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be' };
      try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' }; }
      catch (e) { return { text: new TextDecoder('windows-1252').decode(u8), encoding: 'windows-1252' }; }
    }
    return { text: new TextDecoder(encoding.replace('-bom', '')).decode(encoding === 'utf-8-bom' ? u8.subarray(3) : u8), encoding };
  };

  /* ============================== CSV ============================== */
  /** RFC 4180 parser. Stops after maxRows records (preview = head(N) at the source). */
  IO.parseCSV = function (text, delim, maxRows, skipRows) {
    const rows = [];
    const n = text.length, limit = maxRows === undefined || maxRows === null ? Infinity : maxRows;
    const D = (delim || ',').charCodeAt(0), Q = 34, CR = 13, LF = 10;
    skipRows = skipRows || 0;
    let skipped = 0, row = [], i = 0;
    const endRow = () => {
      if (skipped < skipRows) skipped++;
      else if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    };
    while (i < n) {
      let c = text.charCodeAt(i);
      if (c === Q) {
        let j = i + 1, s = '', from = j;
        for (;;) {
          const k = text.indexOf('"', j);
          if (k < 0) { s += text.slice(from); j = n; break; }
          if (text.charCodeAt(k + 1) === Q) { s += text.slice(from, k + 1); j = k + 2; from = j; continue; }
          s += text.slice(from, k); j = k + 1; break;
        }
        let e = j;
        while (e < n) { const x = text.charCodeAt(e); if (x === D || x === CR || x === LF) break; e++; }
        if (e > j) s += text.slice(j, e);
        row.push(s);
        i = e;
      } else {
        let e = i;
        while (e < n) { c = text.charCodeAt(e); if (c === D || c === CR || c === LF) break; e++; }
        row.push(e > i ? text.slice(i, e) : '');
        i = e;
      }
      if (i >= n) break;
      c = text.charCodeAt(i);
      if (c === D) { i++; if (i >= n) row.push(''); continue; }
      i++;
      if (c === CR && text.charCodeAt(i) === LF) i++;
      endRow();
      if (rows.length >= limit) return { rows, truncated: i < n };
    }
    if (row.length) endRow();
    return { rows, truncated: false };
  };

  /** Sniff delimiter (consistency of field counts), header presence and decimal separator. */
  IO.sniffCSV = function (text) {
    const sample = text.slice(0, 64 * 1024);
    let best = { delim: ',', score: -1 };
    for (const d of [',', ';', '\t', '|']) {
      const { rows } = IO.parseCSV(sample, d, 30);
      if (rows.length === 0) continue;
      const counts = rows.map((r) => r.length);
      const mode = counts.sort((a, b) => counts.filter((v) => v === a).length - counts.filter((v) => v === b).length).pop();
      if (mode < 2) continue;
      const consistent = rows.filter((r) => r.length === mode).length / rows.length;
      const score = consistent * 10 + Math.min(mode, 20) / 20;
      if (score > best.score) best = { delim: d, score };
    }
    const { rows } = IO.parseCSV(sample, best.delim, 50);
    // decimal-comma detection: many cells like 1.234,56 or 12,5 and delimiter isn't comma
    let commaDec = 0, dotDec = 0;
    rows.slice(1).forEach((r) => r.forEach((v) => {
      if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(v) || /^-?\d+,\d{1,2}$/.test(v)) commaDec++;
      if (/^-?\d{1,3}(,\d{3})*\.\d+$/.test(v) || /^-?\d+\.\d+$/.test(v)) dotDec++;
    }));
    const locale = best.delim !== ',' && commaDec > dotDec ? 'de-DE' : 'en-US';
    const header = rows.length > 1 ? IO.detectHeader(rows.slice(0, 30).map((r) => r.map((v) => (v === '' ? null : v)))).row === 0 : true;
    return { delimiter: best.delim, locale, header };
  };

  function csvTable(rec, opts, maxRows) {
    const { text, encoding } = decodeCached(rec, opts.encoding);
    const delim = opts.delimiter || IO.sniffCSV(text).delimiter;
    const want = maxRows === Infinity || maxRows === undefined ? undefined : maxRows + (opts.header ? 1 : 0);
    const { rows, truncated } = IO.parseCSV(text, delim, want, opts.skipRows || 0);
    let names;
    let body = rows;
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    if (opts.header !== false && rows.length) { names = PQ.uniquify(rows[0].concat(Array(Math.max(0, width - rows[0].length)).fill(null))); body = rows.slice(1); }
    else names = PQ.uniquify(Array.from({ length: width }, (_, i) => 'Column' + (i + 1)));
    const data = names.map(() => new Array(body.length));
    for (let r = 0; r < body.length; r++) {
      const row = body[r];
      for (let c = 0; c < names.length; c++) { const v = row[c]; data[c][r] = v === undefined || v === '' ? null : v; }
    }
    const t = new Table(names.map((n) => ({ name: n, type: 'text' })), data, body.length);
    t.meta = { truncated, encoding, delimiter: delim };
    return t;
  }

  const textCache = new Map();
  function decodeCached(rec, encoding) {
    const k = rec.id + ':' + rec.mtime + ':' + rec.size + ':' + (encoding || 'auto');
    let v = textCache.get(k);
    if (!v) {
      v = IO.decode(rec.buf, encoding);
      textCache.set(k, v);
      let total = 0;
      for (const x of textCache.values()) total += x.text.length;
      while (textCache.size > 1 && (textCache.size > 4 || total > 400e6)) { const first = textCache.keys().next().value; total -= textCache.get(first).text.length; textCache.delete(first); }
    } else { textCache.delete(k); textCache.set(k, v); }
    return v;
  }
  IO.decodeCached = decodeCached;

  /* ============================== Header detection ============================== */
  /** Scores candidate header rows: share of text cells, uniqueness, fill, and a type change on the rows below. */
  IO.detectHeader = function (grid) {
    const rows = grid.slice(0, 15);
    if (!rows.length) return { row: 0, confidence: 0, reasons: [] };
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    const kind = (v) => (v === null || v === undefined || v === '' ? 'e' : typeof v === 'number' || v instanceof Date ? 'n' : typeof v === 'boolean' ? 'b' : PQ.parseNumber(v) !== null || PQ.parseDate(v, 'en-US', true) ? 'n' : 't');
    let best = { row: 0, score: -Infinity, reasons: [] };
    for (let r = 0; r < Math.min(rows.length - 1, 10); r++) {
      const row = rows[r];
      const kinds = Array.from({ length: width }, (_, c) => kind(row[c]));
      const filled = kinds.filter((k) => k !== 'e').length;
      if (filled < 2 || filled < width * 0.5) continue;
      const textShare = kinds.filter((k) => k === 't').length / filled;
      const vals = row.filter((v) => v !== null && v !== '').map(String);
      const unique = new Set(vals).size / vals.length;
      // type change: for columns where header is text, how many rows below are non-text
      let change = 0, cols = 0;
      for (let c = 0; c < width; c++) {
        if (kinds[c] !== 't') continue;
        const below = rows.slice(r + 1, r + 8).map((x) => kind(x[c])).filter((k) => k !== 'e');
        if (!below.length) continue;
        cols++;
        change += below.filter((k) => k !== 't').length / below.length;
      }
      const typeChange = cols ? change / cols : 0;
      const nextFilled = rows[r + 1] ? rows[r + 1].filter((v) => v !== null && v !== '').length / width : 0;
      const score = textShare * 3 + unique * 2 + (filled / width) * 2 + typeChange * 3 + nextFilled - r * 0.05;
      if (score > best.score) best = { row: r, score, reasons: [Math.round(textShare * 100) + '% text', Math.round(unique * 100) + '% unique', Math.round(typeChange * 100) + '% type change below'] };
    }
    const confidence = Math.max(0, Math.min(1, (best.score - 3) / 7));
    return { row: best.row, confidence: +confidence.toFixed(2), reasons: best.reasons };
  };

  /* ============================== Excel ============================== */
  const wbCache = new Map();
  function workbook(rec) {
    const key = rec.id + ':' + rec.mtime;
    if (wbCache.has(key)) return wbCache.get(key);
    if (!PQ.lib('xlsx')) throw new PQ.StepError('Excel reader (SheetJS) failed to load — reload the app');
    const wb = XLSX.read(new Uint8Array(rec.buf), { type: 'array', cellNF: true, cellDates: false, cellStyles: false, sheetStubs: false, dense: true });
    const info = { wb, date1904: !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904), tables: /\.xls[xm]$/i.test(rec.name) ? readListObjects(rec.buf, wb) : [], dateFmt: new Map() };
    wbCache.set(key, info);
    if (wbCache.size > 8) wbCache.delete(wbCache.keys().next().value);
    return info;
  }

  /** Excel Tables (ListObjects) aren't exposed by SheetJS CE, so read xl/tables/*.xml from the zip directly. */
  function readListObjects(buf, wb) {
    const out = [];
    try {
      const zip = XLSX.CFB.read(new Uint8Array(buf), { type: 'array' });
      const get = (p) => {
        const want = p.toLowerCase();
        const i = zip.FullPaths.findIndex((fp) => fp.toLowerCase().replace(/\\/g, '/').endsWith('/' + want) || fp.toLowerCase() === want);
        const e = i >= 0 ? zip.FileIndex[i] : null;
        return e && e.content ? new TextDecoder().decode(e.content instanceof Uint8Array ? e.content : new Uint8Array(e.content)) : null;
      };
      const xml = (s) => new DOMParserShim(s);
      const wbx = get('xl/workbook.xml'), wbr = get('xl/_rels/workbook.xml.rels');
      if (!wbx || !wbr) return out;
      const rels = {};
      xml(wbr).all('Relationship').forEach((r) => { rels[r.Id] = r.Target; });
      xml(wbx).all('sheet').forEach((s) => {
        const rid = s['r:id'];
        let target = rels[rid]; if (!target) return;
        target = target.replace(/^\/?xl\//, '');
        const file = target.split('/').pop();
        const srels = get('xl/worksheets/_rels/' + file + '.rels');
        if (!srels) return;
        xml(srels).all('Relationship').forEach((r) => {
          if (!/\/table$/.test(r.Type)) return;
          const tpath = 'xl/' + r.Target.replace(/^\.\.\//, '').replace(/^\/?xl\//, '');
          const tx = get(tpath); if (!tx) return;
          const t = xml(tx).all('table')[0]; if (!t) return;
          out.push({ name: t.displayName || t.name, sheet: s.name, ref: t.ref, headerRows: t.headerRowCount === undefined ? 1 : +t.headerRowCount, totalsRows: +(t.totalsRowCount || 0) });
        });
      });
    } catch (e) { /* best effort; xls/ods/xlsb have no ListObjects here */ }
    return out;
  }
  /** Minimal attribute scanner — DOMParser isn't available inside Web Workers. */
  function DOMParserShim(s) { this.s = s; }
  DOMParserShim.prototype.all = function (tag) {
    const re = new RegExp('<(?:\\w+:)?' + tag + '\\b([^>]*)>', 'g'), out = [];
    let m;
    while ((m = re.exec(this.s))) {
      const o = {}, ar = /([\w:]+)="([^"]*)"/g;
      let a;
      while ((a = ar.exec(m[1]))) o[a[1]] = a[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
      out.push(o);
    }
    return out;
  };

  let fmtMemo = new Map();
  function isDateFmt(z) {
    let v = fmtMemo.get(z);
    if (v === undefined) { v = !!XLSX.SSF.is_date(z); if (fmtMemo.size > 2000) fmtMemo = new Map(); fmtMemo.set(z, v); }
    return v;
  }
  function getCell(ws, r, c) {
    if (Array.isArray(ws)) { const row = ws[r]; return row ? row[c] : undefined; }
    const d = ws['!data'];
    if (d) { const row = d[r]; return row ? row[c] : undefined; }
    return ws[XLSX.utils.encode_cell({ r, c })];
  }
  function cellValue(cell, date1904) {
    if (!cell) return null;
    switch (cell.t) {
      case 'n': {
        if (cell.z && cell.z !== 'General' && isDateFmt(cell.z)) return PQ.excelSerialToDate(cell.v, date1904);
        return cell.v;
      }
      case 's': case 'str': return cell.v === '' ? null : cell.v;
      case 'b': return cell.v;
      case 'd': return cell.v instanceof Date ? new Date(Date.UTC(cell.v.getFullYear(), cell.v.getMonth(), cell.v.getDate(), cell.v.getHours(), cell.v.getMinutes(), cell.v.getSeconds())) : null;
      case 'e': return new CellError('Excel error ' + (cell.w || '#ERR'), cell.w);
      case 'z': return null;
    }
    return cell.v === undefined ? null : cell.v;
  }

  function sheetBounds(ws) {
    if (!ws || !ws['!ref']) return null;
    const r = XLSX.utils.decode_range(ws['!ref']);
    return { r1: r.s.r, c1: r.s.c, r2: r.e.r, c2: r.e.c };
  }

  /** Read a rectangular block as a 2D array of typed values. Honors merged-cell fill. */
  function readGrid(info, sheetName, range, opts, maxRows) {
    const ws = info.wb.Sheets[sheetName];
    if (!ws) throw new PQ.StepError('Sheet "' + sheetName + '" not found in workbook', { available: info.wb.SheetNames });
    const b = sheetBounds(ws);
    if (!b) return [];
    const r1 = Math.max(range ? range.r1 : b.r1, 0), c1 = Math.max(range ? range.c1 : b.c1, 0);
    const r2 = Math.min(range && range.r2 !== Infinity ? range.r2 : b.r2, b.r2), c2 = Math.min(range && range.c2 !== Infinity ? range.c2 : b.c2, b.c2);
    const lastRow = maxRows === undefined || maxRows === Infinity ? r2 : Math.min(r2, r1 + maxRows - 1);
    const merged = opts && opts.fillMerged ? ws['!merges'] || [] : [];
    const mergeMap = new Map();
    for (const m of merged) {
      const tl = cellValue(getCell(ws, m.s.r, m.s.c), info.date1904);
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) if (r !== m.s.r || c !== m.s.c) mergeMap.set(r * 20000 + c, tl);
    }
    const grid = [];
    for (let r = r1; r <= lastRow; r++) {
      const row = new Array(c2 - c1 + 1);
      let any = false;
      for (let c = c1; c <= c2; c++) {
        const key = r * 20000 + c;
        let v = mergeMap.size && mergeMap.has(key) ? mergeMap.get(key) : cellValue(getCell(ws, r, c), info.date1904);
        if (typeof v === 'string' && v.trim() === '') v = null;
        row[c - c1] = v;
        if (v !== null) any = true;
      }
      row.blank = !any;
      grid.push(row);
    }
    return grid;
  }

  /** Contiguous data regions (8-connectivity on non-empty cells), for sheets with stacked / side-by-side tables. */
  function detectRegions(info, sheetName) {
    const ws = info.wb.Sheets[sheetName];
    const b = sheetBounds(ws);
    if (!b) return [];
    const H = Math.min(b.r2 - b.r1 + 1, 2000), W = Math.min(b.c2 - b.c1 + 1, 200);
    const filled = new Uint8Array(H * W);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const cell = getCell(ws, r + b.r1, c + b.c1);
      if (cell && cell.v !== undefined && cell.v !== null && cell.v !== '') filled[r * W + c] = 1;
    }
    (ws['!merges'] || []).forEach((m) => {
      for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) { const rr = r - b.r1, cc = c - b.c1; if (rr >= 0 && rr < H && cc >= 0 && cc < W) filled[rr * W + cc] = 1; }
    });
    const seen = new Uint8Array(H * W), regions = [];
    for (let i = 0; i < H * W; i++) {
      if (!filled[i] || seen[i]) continue;
      let r1 = H, c1 = W, r2 = -1, c2 = -1, count = 0;
      const stack = [i]; seen[i] = 1;
      while (stack.length) {
        const k = stack.pop(), r = (k / W) | 0, c = k % W;
        count++;
        if (r < r1) r1 = r; if (r > r2) r2 = r; if (c < c1) c1 = c; if (c > c2) c2 = c;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= H || cc >= W) continue;
          const j = rr * W + cc;
          if (filled[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
      if (r2 - r1 >= 1 && c2 - c1 >= 1 && count >= 4) regions.push({ r1: r1 + b.r1, c1: c1 + b.c1, r2: r2 + b.r1, c2: c2 + b.c1, cells: count });
    }
    return regions.sort((a, b2) => a.r1 - b2.r1 || a.c1 - b2.c1).map((g) => {
      const grid = readGrid(info, sheetName, g, { fillMerged: true }, 15);
      return { a1: PQ.fmtA1(g), rows: g.r2 - g.r1 + 1, cols: g.c2 - g.c1 + 1, header: IO.detectHeader(grid) };
    });
  }

  function previewGrid(grid) {
    return grid.slice(0, 40).map((r) => Array.from(r).slice(0, 26).map((v) => (v instanceof CellError ? '#ERR' : PQ.fmtValue(v))));
  }

  /** Navigator tree for a workbook: tables first (cleanest source), then sheets with regions, named ranges. */
  IO.inspectExcel = function (rec) {
    const info = workbook(rec);
    const wbm = info.wb.Workbook || {};
    const sheets = info.wb.SheetNames.map((name, i) => {
      const ws = info.wb.Sheets[name];
      const b = sheetBounds(ws);
      const hidden = !!(wbm.Sheets && wbm.Sheets[i] && wbm.Sheets[i].Hidden);
      if (!b) return { name, hidden, empty: true, rows: 0, cols: 0, regions: [], merges: 0, preview: [] };
      const grid = readGrid(info, name, null, { fillMerged: false }, 40);
      const regions = detectRegions(info, name);
      const header = IO.detectHeader(readGrid(info, name, null, { fillMerged: true }, 15));
      return { name, hidden, ref: ws['!ref'], rows: b.r2 - b.r1 + 1, cols: b.c2 - b.c1 + 1, origin: { r: b.r1, c: b.c1 }, merges: (ws['!merges'] || []).length, regions, header, preview: previewGrid(grid) };
    });
    const names = (wbm.Names || []).filter((n) => n.Ref && !/^_xlnm\./.test(n.Name) && !/#REF!/.test(n.Ref)).map((n) => ({ name: n.Name, ref: n.Ref, scope: n.Sheet !== undefined ? info.wb.SheetNames[n.Sheet] : null }));
    return { kind: 'excel', date1904: info.date1904, sheets, tables: info.tables, names };
  };

  function gridToTable(grid, header) {
    // trim trailing blank rows/cols
    let end = grid.length; while (end > 0 && grid[end - 1].blank) end--;
    grid = grid.slice(0, end);
    let width = 0; grid.forEach((r) => { for (let c = r.length - 1; c >= 0; c--) if (r[c] !== null) { width = Math.max(width, c + 1); break; } });
    let names, body = grid;
    if (header && grid.length) { names = PQ.uniquify(Array.from({ length: width }, (_, c) => (grid[0][c] === null || grid[0][c] === undefined ? null : PQ.fmtValue(grid[0][c])))); body = grid.slice(1); }
    else names = Array.from({ length: width }, (_, c) => 'Column' + (c + 1));
    const data = names.map(() => new Array(body.length));
    for (let r = 0; r < body.length; r++) for (let c = 0; c < width; c++) data[c][r] = body[r][c] === undefined ? null : body[r][c];
    return new Table(names.map((n, i) => ({ name: n, type: PQ.valuesType(data[i]) })), data, body.length);
  }

  /** Read one navigator item into a Table. maxRows = preview limit. */
  IO.readExcel = function (rec, item, opts, maxRows) {
    const info = workbook(rec);
    opts = opts || {};
    const extra = maxRows === Infinity || maxRows === undefined ? Infinity : maxRows + 1;
    if (item.type === 'table') {
      const t = info.tables.find((x) => x.name === item.name);
      if (!t) throw new PQ.StepError('Excel table "' + item.name + '" not found', { available: info.tables.map((x) => x.name) });
      const rg = PQ.parseA1(t.ref);
      if (t.totalsRows) rg.r2 -= t.totalsRows;
      return gridToTable(readGrid(info, t.sheet, rg, opts, extra), t.headerRows > 0);
    }
    if (item.type === 'name') {
      const n = (info.wb.Workbook.Names || []).find((x) => x.Name === item.name);
      if (!n) throw new PQ.StepError('Named range "' + item.name + '" not found');
      const rg = PQ.parseA1(n.Ref);
      return gridToTable(readGrid(info, rg.sheet, rg, opts, extra), false);
    }
    if (item.type === 'range' || item.type === 'sheet') {
      const rg = item.type === 'range' && item.range ? PQ.parseA1(item.range) : null;
      if (item.type === 'range' && item.range && !rg) throw new PQ.StepError('Invalid range "' + item.range + '" — use A1 notation like B3:H500 or B3:H');
      return gridToTable(readGrid(info, item.sheet || item.name, rg, opts, extra), false);
    }
    if (item.type === 'sheets') {
      const re = PQ.globToRegex(item.pattern || '*');
      const parts = [];
      info.wb.SheetNames.forEach((name, i) => {
        const hidden = info.wb.Workbook && info.wb.Workbook.Sheets && info.wb.Workbook.Sheets[i] && info.wb.Workbook.Sheets[i].Hidden;
        if (!re.test(name) || (hidden && !item.includeHidden)) return;
        const grid = readGrid(info, name, null, opts, extra);
        const h = IO.detectHeader(grid.slice(0, 15));
        const t = gridToTable(grid.slice(h.row), true);
        parts.push(t.withColumn(item.sheetColumn || '_sheet', 'text', new Array(t.n).fill(name), 0));
      });
      if (!parts.length) throw new PQ.StepError('No sheets match "' + item.pattern + '"', { available: info.wb.SheetNames });
      return PQ.concatDiagonal(parts);
    }
    throw new PQ.StepError('Unknown Excel item type ' + item.type);
  };

  /** Diagonal concat: union columns by name, fill missing with null. */
  PQ.concatDiagonal = function (tables) {
    const names = [], types = new Map();
    tables.forEach((t) => t.cols.forEach((c) => {
      if (!types.has(c.name)) { names.push(c.name); types.set(c.name, c.type); }
      else if (types.get(c.name) !== c.type) types.set(c.name, (types.get(c.name) === 'int' && c.type === 'number') || (types.get(c.name) === 'number' && c.type === 'int') ? 'number' : 'any');
    }));
    const n = tables.reduce((s, t) => s + t.n, 0);
    const data = names.map((name) => {
      const out = new Array(n); let k = 0;
      tables.forEach((t) => { const i = t.index(name); if (i < 0) { for (let r = 0; r < t.n; r++) out[k++] = null; } else { const col = t.data[i]; for (let r = 0; r < t.n; r++) out[k++] = col[r]; } });
      return out;
    });
    return new Table(names.map((nm) => ({ name: nm, type: types.get(nm) })), data, n);
  };

  /* ============================== JSON ============================== */
  IO.readJSON = function (rec, maxRows) {
    const { text } = IO.decode(rec.buf);
    let rows;
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) rows = JSON.parse(trimmed);
    else if (trimmed.startsWith('{') && !/\n\s*\{/.test(trimmed)) { const o = JSON.parse(trimmed); const arr = Object.values(o).find(Array.isArray); rows = arr || [o]; }
    else rows = trimmed.split(/\r?\n/).filter((l) => l.trim()).slice(0, maxRows === Infinity ? undefined : maxRows).map((l) => JSON.parse(l)); // NDJSON
    if (maxRows !== Infinity) rows = rows.slice(0, maxRows);
    const names = [];
    const seen = new Set();
    rows.forEach((r) => Object.keys(r || {}).forEach((k) => { if (!seen.has(k)) { seen.add(k); names.push(k); } }));
    const data = names.map((k) => rows.map((r) => { const v = r ? r[k] : null; return v === undefined ? null : v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }));
    return new Table(names.map((n, i) => ({ name: n, type: PQ.valuesType(data[i]) })), data, rows.length);
  };

  /* ============================== Source dispatcher ============================== */
  IO.fileKind = function (name) {
    const ext = String(name).toLowerCase().split('.').pop();
    if (['xlsx', 'xlsm', 'xlsb', 'xls', 'ods'].includes(ext)) return 'excel';
    if (['csv', 'tsv', 'txt'].includes(ext)) return 'csv';
    if (['json', 'ndjson', 'jsonl'].includes(ext)) return 'json';
    return 'unknown';
  };
  IO.readFile = function (rec, spec, maxRows) {
    const kind = spec.format || IO.fileKind(rec.name);
    if (kind === 'excel') return IO.readExcel(rec, spec.item || { type: 'sheet', name: 0 }, { fillMerged: spec.fillMerged }, maxRows);
    if (kind === 'json') return IO.readJSON(rec, maxRows);
    return csvTable(rec, spec.csv || {}, maxRows);
  };
  IO.inspectFile = function (rec) {
    const kind = IO.fileKind(rec.name);
    if (kind === 'excel') return IO.inspectExcel(rec);
    if (kind === 'csv') {
      const { text, encoding } = decodeCached(rec);
      const sniff = IO.sniffCSV(text);
      const { rows } = IO.parseCSV(text, sniff.delimiter, 40);
      return { kind: 'csv', encoding, ...sniff, preview: rows.map((r) => r.slice(0, 26)) };
    }
    if (kind === 'json') { const t = IO.readJSON(rec, 40); return { kind: 'json', preview: [t.names].concat(t.toRows(39).map((r) => r.map((v) => PQ.fmtValue(v)))) }; }
    throw new PQ.StepError('Unsupported file type: ' + rec.name);
  };

  /* ============================== Writers ============================== */
  IO.toCSV = function (t, delim) {
    delim = delim || ',';
    const needs = new RegExp('["\\n\\r' + delim.replace(/[\\\]^-]/g, '\\$&') + ',]');
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(10));
      const s = v instanceof CellError ? '#ERROR' : PQ.fmtValue(v);
      return needs.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const parts = [t.names.map(esc).join(delim)];
    const cols = t.data, m = cols.length;
    let chunk = [];
    for (let r = 0; r < t.n; r++) {
      let line = m ? esc(cols[0][r]) : '';
      for (let c = 1; c < m; c++) line += delim + esc(cols[c][r]);
      chunk.push(line);
      if (chunk.length === 50000) { parts.push(chunk.join('\r\n')); chunk = []; }
    }
    if (chunk.length) parts.push(chunk.join('\r\n'));
    return parts.join('\r\n');
  };
  IO.toXLSX = function (t, sheetName) {
    if (!PQ.lib('xlsx')) throw new PQ.StepError('Excel writer (SheetJS) failed to load — reload the app');
    const aoa = [t.names].concat(t.toRows().map((row) => row.map((v) => (v instanceof CellError ? '#ERROR' : v instanceof Date ? v : v))));
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true, dateNF: 'yyyy-mm-dd' });
    ws['!autofilter'] = { ref: ws['!ref'] };
    ws['!cols'] = t.names.map((n, i) => {
      let w = String(n).length;
      for (let r = 0; r < Math.min(t.n, 500); r++) { const v = t.data[i][r]; if (v !== null) w = Math.max(w, String(PQ.fmtValue(v)).length); }
      return { wch: Math.min(60, w + 2) };
    });
    t.cols.forEach((c, i) => {
      const fmt = c.type === 'date' ? 'yyyy-mm-dd' : c.type === 'datetime' ? 'yyyy-mm-dd hh:mm:ss' : c.type === 'number' ? '#,##0.00' : null;
      if (!fmt) return;
      for (let r = 1; r <= t.n; r++) { const cell = getCell(ws, r, i); if (cell) cell.z = fmt; }
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, String(sheetName || 'Data').slice(0, 31).replace(/[\\/?*[\]:]/g, '_'));
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true });
  };
  IO.toTSV = function (t, limit) {
    const lines = [t.names.join('\t')];
    for (let r = 0; r < Math.min(t.n, limit || t.n); r++) lines.push(t.data.map((c) => { const v = c[r]; return v === null ? '' : v instanceof CellError ? '#ERROR' : String(PQ.fmtValue(v)).replace(/[\t\r\n]/g, ' '); }).join('\t'));
    return lines.join('\n');
  };

  /* ============================== Sample data (a deliberately messy set) ============================== */
  IO.makeSamples = function () {
    PQ.lib('xlsx');
    let seed = 42;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const regions = ['EU', 'US', 'APAC', 'LATAM'];
    const products = [['P-100', 'Widget', 12.5], ['P-101', 'Gadget', 30], ['P-102', 'Doohickey', 7.25], ['P-103', 'Sprocket', 3.4], ['P-104', 'Gizmo', 99], ['P-105', 'Thingamajig', 45.9]];
    const first = ['Ana', 'Ben', 'Chloé', 'Dmitri', 'Eva', 'Farid', 'Grace', 'Hiro', 'Ines', 'Jonas', 'Kofi', 'Lena', 'Mateo', 'Nora', 'Omar', 'Priya'];
    const last = ['Silva', 'Novak', 'Martin', 'Ivanov', 'Berg', 'Haddad', 'Lee', 'Tanaka', 'García', 'Weber', 'Mensah', 'Fischer', 'Rossi', 'Kaur'];
    const out = [];

    // customers.csv — clean-ish with a duplicate id (to show the non-unique key warning)
    const cust = ['customer_id,customer_name,region,segment,signup_date'];
    for (let i = 1; i <= 400; i++) cust.push([`C${String(i).padStart(4, '0')}`, `"${pick(first)} ${pick(last)}"`, pick(regions), pick(['Consumer', 'SMB', 'Enterprise']), `2024-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`].join(','));
    cust.push('C0007,"Duplicate Record",EU,SMB,2025-01-01');
    out.push({ name: 'customers.csv', text: cust.join('\n') });

    // orders.csv — 60k rows, messy numbers ("1,234.50", blanks, "n/a"), mixed date formats
    const ord = ['order_id,order_date,customer_id,product_id,quantity,unit_price,discount,status'];
    for (let i = 1; i <= 60000; i++) {
      const p = pick(products), d = new Date(Date.UTC(2025, 0, 1) + Math.floor(rnd() * 600) * 86400000);
      const iso = d.toISOString().slice(0, 10);
      const q = 1 + Math.floor(rnd() * 20);
      let price = (p[2] * (0.9 + rnd() * 0.2)).toFixed(2);
      if (rnd() < 0.01) price = 'n/a';
      else if (price >= 1000) price = '"' + Number(price).toLocaleString('en-US', { minimumFractionDigits: 2 }) + '"';
      const disc = rnd() < 0.3 ? (rnd() * 0.2).toFixed(2) : '';
      ord.push([100000 + i, iso, `C${String(1 + Math.floor(rnd() * 420)).padStart(4, '0')}`, p[0], q, price, disc, pick(['shipped', 'shipped', 'shipped', 'Shipped ', 'returned', 'pending'])].join(','));
    }
    out.push({ name: 'orders.csv', text: ord.join('\n') });

    // Report-style workbook: title rows, merged cells, stacked tables, hidden sheet, subtotal rows, named range
    const wb = XLSX.utils.book_new();
    const rep = [
      ['ACME Corp — Regional Sales Report', null, null, null, null, null],
      ['Generated 2026-09-01 · Confidential', null, null, null, null, null],
      [],
      ['Region', 'Product', 'Jan', 'Feb', 'Mar', 'Apr'],
    ];
    const merges = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 5 } }];
    let r0 = 4;
    for (const reg of regions) {
      const start = r0;
      products.slice(0, 4).forEach((p, i) => { rep.push([i === 0 ? reg : null, p[1], ...[0, 1, 2, 3].map(() => Math.round(rnd() * 5000))]); r0++; });
      merges.push({ s: { r: start, c: 0 }, e: { r: r0 - 1, c: 0 } });
      rep.push([null, 'Subtotal', null, null, null, null]); r0++;
    }
    rep.push([]); rep.push([]);
    rep.push(['Targets by region', null, null]); rep.push(['Region', 'Target', 'Owner']);
    regions.forEach((reg) => rep.push([reg, 50000 + Math.round(rnd() * 20000), pick(first)]));
    const ws1 = XLSX.utils.aoa_to_sheet(rep);
    ws1['!merges'] = merges;
    // subtotal formulas are just text-empty; fill a formula-looking value
    const ws2rows = [['Date', 'Store', 'Amount', 'Paid']];
    for (let i = 0; i < 300; i++) ws2rows.push([new Date(Date.UTC(2026, 0, 1) + i * 86400000), pick(['Berlin', 'Lisbon', 'Austin', 'Osaka']), +(rnd() * 900).toFixed(2), rnd() > 0.2]);
    const ws2 = XLSX.utils.aoa_to_sheet(ws2rows, { cellDates: true });
    const q = (m) => { const rows = [['Region', 'Units', 'Revenue']]; regions.forEach((rg) => rows.push([rg, Math.round(rnd() * 900), +(rnd() * 90000).toFixed(2)])); if (m === 'Q3') rows[0].push('Returns'), rows.slice(1).forEach((r) => r.push(Math.round(rnd() * 40))); return XLSX.utils.aoa_to_sheet(rows); };
    XLSX.utils.book_append_sheet(wb, ws1, 'Report');
    XLSX.utils.book_append_sheet(wb, ws2, 'Daily');
    XLSX.utils.book_append_sheet(wb, q('Q1'), 'Sales Q1');
    XLSX.utils.book_append_sheet(wb, q('Q2'), 'Sales Q2');
    XLSX.utils.book_append_sheet(wb, q('Q3'), 'Sales Q3');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['internal', 'lookup'], ['a', 1]]), 'Lookup');
    wb.Workbook = { Sheets: [{}, {}, {}, {}, {}, { Hidden: 1 }], Names: [{ Name: 'TargetsRange', Ref: "Report!$A$" + (r0 + 4) + ":$C$" + (r0 + 8) }] };
    out.push({ name: 'regional_report.xlsx', buf: XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true }) });

    // Folder of monthly CSV exports with drifting schemas
    ['2026-06', '2026-07', '2026-08'].forEach((m, k) => {
      const hdr = k === 2 ? 'date;store;amount;currency;channel' : 'date;store;amount;currency';
      const lines = [hdr];
      for (let i = 0; i < 200; i++) {
        const day = String(1 + Math.floor(rnd() * 28)).padStart(2, '0');
        const amt = (rnd() * 500).toFixed(2).replace('.', ',');
        const row = [`${day}.${m.slice(5)}.${m.slice(0, 4)}`, pick(['Berlin', 'Lisbon', 'Austin', 'Osaka']), amt, 'EUR'];
        if (k === 2) row.push(pick(['web', 'store']));
        lines.push(row.join(';'));
      }
      out.push({ name: `sales_${m}.csv`, text: lines.join('\n'), folder: 'monthly_exports' });
    });
    return out;
  };
})();
