/* Core utilities: Table, types, casting, locales, hashing, A1 ranges, IndexedDB file store. */
(function () {
  const PQ = (self.PQ = self.PQ || {}); // `self` works both on the page and inside the engine Web Worker
  /** Product identity — the only place the name lives. */
  PQ.BRAND = { name: 'Floe', tagline: 'Data preparation', full: 'Floe — data preparation', ext: 'floe', cli: 'floe', id: 'dev.floe.desktop' };
  PQ.VERSION = '1.1.0';

  /* ---------- Per-cell errors (Polars has none; we add them, like the plan's error mask) ---------- */
  class CellError {
    constructor(msg, orig) { this.msg = msg; this.orig = orig; }
    toString() { return 'Error'; }
  }
  PQ.CellError = CellError;
  PQ.isErr = (v) => v instanceof CellError;
  PQ.isEmpty = (v) => v === null || v === undefined || v === '';

  class StepError extends Error {
    constructor(msg, extra) { super(msg); Object.assign(this, extra || {}); }
  }
  class MissingColumnError extends StepError {
    constructor(col, available) {
      super('Column `' + col + '` not found', { available });
      this.missingColumn = col;
    }
  }
  PQ.StepError = StepError;
  PQ.MissingColumnError = MissingColumnError;

  /* ---------- Column-oriented immutable table (Arrow-like). Never mutate column arrays in place. ---------- */
  class Table {
    constructor(cols, data, n) {
      this.cols = cols;
      this.data = data;
      this.n = n !== undefined ? n : data[0] ? data[0].length : 0;
      this._idx = null;
    }
    get names() { return this.cols.map((c) => c.name); }
    index(name) {
      if (!this._idx) { this._idx = new Map(); this.cols.forEach((c, i) => this._idx.set(c.name, i)); }
      return this._idx.has(name) ? this._idx.get(name) : -1;
    }
    has(name) { return this.index(name) >= 0; }
    get(name) {
      const i = this.index(name);
      if (i < 0) throw new MissingColumnError(name, this.names);
      return this.data[i];
    }
    type(name) { const i = this.index(name); return i < 0 ? 'any' : this.cols[i].type; }
    need(names) { for (const n of names) if (!this.has(n)) throw new MissingColumnError(n, this.names); }
    schema() { return this.cols.map((c) => ({ name: c.name, type: c.type })); }
    row(i) { return this.data.map((col) => col[i]); }
    take(ix) {
      return new Table(this.cols.map((c) => ({ ...c })), this.data.map((col) => {
        const out = new Array(ix.length);
        for (let k = 0; k < ix.length; k++) out[k] = ix[k] < 0 ? null : col[ix[k]];
        return out;
      }), ix.length);
    }
    slice(s, e) {
      e = Math.min(e, this.n); s = Math.min(s, e);
      return new Table(this.cols.map((c) => ({ ...c })), this.data.map((col) => col.slice(s, e)), e - s);
    }
    /** Replace column (same position) or append a new one. Shares other column arrays. */
    withColumn(name, type, arr, position) {
      const i = this.index(name);
      const cols = this.cols.map((c) => ({ ...c }));
      const data = this.data.slice();
      if (i >= 0) { cols[i] = { name, type }; data[i] = arr; }
      else if (position !== undefined && position >= 0 && position <= cols.length) {
        cols.splice(position, 0, { name, type }); data.splice(position, 0, arr);
      } else { cols.push({ name, type }); data.push(arr); }
      return new Table(cols, data, this.n);
    }
    select(names) {
      this.need(names);
      return new Table(names.map((n) => ({ name: n, type: this.type(n) })), names.map((n) => this.get(n)), this.n);
    }
    toRows(limit) {
      const n = Math.min(this.n, limit === undefined ? this.n : limit), out = new Array(n);
      for (let r = 0; r < n; r++) out[r] = this.data.map((c) => c[r]);
      return out;
    }
    static fromRows(names, rows, types) {
      const data = names.map(() => new Array(rows.length));
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        for (let c = 0; c < names.length; c++) { const v = row[c]; data[c][r] = v === undefined ? null : v; }
      }
      return new Table(names.map((n, i) => ({ name: n, type: (types && types[i]) || 'any' })), data, rows.length);
    }
    static empty() { return new Table([], [], 0); }
  }
  PQ.Table = Table;

  PQ.uniqueName = function (name, existing) {
    const set = existing instanceof Set ? existing : new Set(existing);
    if (!set.has(name)) return name;
    let i = 1;
    while (set.has(name + '_' + i)) i++;
    return name + '_' + i;
  };
  PQ.uniquify = function (names) {
    const seen = new Set();
    return names.map((n, i) => {
      let base = n === null || n === undefined || String(n).trim() === '' ? 'Column' + (i + 1) : String(n).trim();
      const u = PQ.uniqueName(base, seen); seen.add(u); return u;
    });
  };

  /* ---------- Types ---------- */
  PQ.TYPES = {
    any: { label: 'Any', icon: 'A1' },
    text: { label: 'Text', icon: 'ABC' },
    number: { label: 'Decimal number', icon: '1.2' },
    int: { label: 'Whole number', icon: '123' },
    bool: { label: 'True/False', icon: '✓✗' },
    date: { label: 'Date', icon: 'DT' },
    datetime: { label: 'Date/Time', icon: 'D⏱' },
  };
  PQ.POLARS_TYPES = { any: 'pl.Object', text: 'pl.String', number: 'pl.Float64', int: 'pl.Int64', bool: 'pl.Boolean', date: 'pl.Date', datetime: 'pl.Datetime' };

  PQ.LOCALES = {
    'en-US': { label: 'English (US) — 1,234.5 · MM/DD/YYYY', dec: '.', thou: ',', dmy: false },
    'en-GB': { label: 'English (UK) — 1,234.5 · DD/MM/YYYY', dec: '.', thou: ',', dmy: true },
    'de-DE': { label: 'German — 1.234,5 · DD.MM.YYYY', dec: ',', thou: '.', dmy: true },
    'fr-FR': { label: 'French — 1 234,5 · DD/MM/YYYY', dec: ',', thou: ' ', dmy: true },
  };

  /** Lenient number parse for messy spreadsheets: currency, %, (accounting negatives), thousands separators. */
  PQ.parseNumber = function (s, locale) {
    const loc = PQ.LOCALES[locale] || PQ.LOCALES['en-US'];
    if (typeof s === 'string' && loc.dec === '.' && s.length) {
      const c = s.charCodeAt(0);
      if ((c >= 48 && c <= 57) || c === 45 || c === 46) {
        const c1 = s.charCodeAt(1) | 32;
        if (!(c === 48 && (c1 === 120 || c1 === 98 || c1 === 111))) {
          const n = +s;
          if (n === n && n !== Infinity && n !== -Infinity) return n;
        }
      }
    }
    let t = String(s).trim();
    if (t === '') return null;
    let neg = false, pct = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (t.endsWith('%')) { pct = true; t = t.slice(0, -1); }
    t = t.replace(/[$€£¥\s\u00a0]/g, '');
    if (loc.dec === ',') t = t.replace(/\./g, '').replace(',', '.');
    else t = t.replace(/,/g, '');
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
    let n = parseFloat(t);
    if (neg) n = -n;
    if (pct) n = n / 100;
    return n;
  };

  const DAY = 86400000;
  PQ.excelSerialToDate = function (serial, date1904) {
    let base;
    if (date1904) base = Date.UTC(1904, 0, 1);
    else base = serial < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30); // Lotus 1900 leap-year bug
    const whole = Math.floor(serial), frac = serial - whole;
    return new Date(base + whole * DAY + Math.round(frac * 86400) * 1000);
  };
  PQ.dateToExcelSerial = (d) => (d.getTime() - Date.UTC(1899, 11, 30)) / DAY;

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function mkDate(y, m, d, hh, mm, ss) {
    if (y < 100) y += y < 50 ? 2000 : 1900;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, m - 1, d, hh || 0, mm || 0, ss || 0));
    if (dt.getUTCDate() !== d) return null;
    return dt;
  }
  /** Parse dates in ISO, locale-ordered numeric, and "12 Mar 2026" / "Mar 12, 2026" forms. strict=true skips fuzzy forms. */
  PQ.parseDate = function (v, locale, strict) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number') return v > 0 && v < 2958466 ? PQ.excelSerialToDate(v, false) : null;
    const s = String(v).trim();
    if (!s) return null;
    const loc = PQ.LOCALES[locale] || PQ.LOCALES['en-US'];
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) return mkDate(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) {
      const a = +m[1], b = +m[2];
      const [d, mo] = loc.dmy ? [a, b] : [b, a];
      return mkDate(+m[3], mo, d, +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    }
    if (strict) return null;
    m = /^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -,]*(\d{2,4})$/.exec(s);
    if (m && MONTHS.indexOf(m[2].toLowerCase()) >= 0) return mkDate(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
    m = /^([A-Za-z]{3})[A-Za-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s);
    if (m && MONTHS.indexOf(m[1].toLowerCase()) >= 0) return mkDate(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
    return null;
  };

  const BOOL_T = new Set(['true', 'yes', 'y', '1', 'wahr', 'vrai']);
  const BOOL_F = new Set(['false', 'no', 'n', '0', 'falsch', 'faux']);

  /** Cast one value. Returns the converted value, null, or a CellError (never throws). */
  PQ.cast = function (v, type, locale) {
    if (v === null || v === undefined) return null;
    if (v instanceof CellError) return v;
    switch (type) {
      case 'any': return v;
      case 'text':
        if (v instanceof Date) return PQ.fmtDate(v);
        return String(v);
      case 'number': case 'int': {
        let n;
        if (typeof v === 'number') n = v;
        else if (typeof v === 'boolean') n = v ? 1 : 0;
        else if (v instanceof Date) return new CellError('Cannot convert a date to a number', v);
        else { if (String(v).trim() === '') return null; n = PQ.parseNumber(v, locale); }
        if (n === null || !isFinite(n)) return new CellError('Cannot convert "' + v + '" to ' + PQ.TYPES[type].label, v);
        return type === 'int' ? Math.round(n) : n;
      }
      case 'bool': {
        if (typeof v === 'boolean') return v;
        if (typeof v === 'number') return v !== 0;
        const s = String(v).trim().toLowerCase();
        if (s === '') return null;
        if (BOOL_T.has(s)) return true;
        if (BOOL_F.has(s)) return false;
        return new CellError('Cannot convert "' + v + '" to True/False', v);
      }
      case 'date': case 'datetime': {
        if (typeof v === 'string' && v.trim() === '') return null;
        const d = PQ.parseDate(v, locale);
        if (!d) return new CellError('Cannot convert "' + v + '" to ' + PQ.TYPES[type].label, v);
        if (type === 'date') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        return d;
      }
    }
    return v;
  };

  PQ.castColumn = function (src, type, locale) {
    const n = src.length, out = new Array(n);
    let errors = 0, first = -1;
    const cast = PQ.cast;
    if (type === 'date' || type === 'datetime' || type === 'bool') {
      const memo = new Map();
      for (let i = 0; i < n; i++) {
        const v = src[i];
        let c;
        if (typeof v === 'string') {
          c = memo.get(v);
          if (c === undefined) { c = cast(v, type, locale); if (memo.size < 250000) memo.set(v, c); }
        } else c = cast(v, type, locale);
        out[i] = c;
        if (c instanceof CellError && !(v instanceof CellError)) { errors++; if (first < 0) first = i; }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const v = src[i];
        const c = typeof v === 'number' && type === 'number' && v - v === 0 ? v : cast(v, type, locale);
        out[i] = c;
        if (c instanceof CellError && !(v instanceof CellError)) { errors++; if (first < 0) first = i; }
      }
    }
    return { values: out, errors, first };
  };

  PQ.collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  const LIBS = {
    xlsx: ['xlsx.full.min.js', () => (typeof XLSX !== 'undefined' ? XLSX : undefined)],
    alasql: ['alasql.min.js', () => (typeof alasql !== 'undefined' ? alasql : undefined)],
    arrow: ['arrow.es2015.min.js', () => (typeof Arrow !== 'undefined' ? Arrow : undefined)],
  };
  PQ.lib = function (name) {
    const [file, get] = LIBS[name];
    let v = get();
    if (v === undefined && typeof importScripts === 'function' && typeof document === 'undefined') {
      try { importScripts('../vendor/' + file); } catch (e) { console.warn('Could not load ' + file, e); }
      v = get();
    }
    return v;
  };

  /** Type of the actual values in an array (used after formulas/SQL). */
  PQ.valuesType = function (arr) {
    let t = null, allInt = true, allMidnight = true;
    const n = Math.min(arr.length, 5000);
    for (let i = 0; i < n; i++) {
      const v = arr[i];
      if (v === null || v === undefined || v instanceof CellError) continue;
      let k;
      if (typeof v === 'number') { k = 'number'; if (!Number.isInteger(v)) allInt = false; }
      else if (typeof v === 'string') k = 'text';
      else if (typeof v === 'boolean') k = 'bool';
      else if (v instanceof Date) { k = 'date'; if (v.getTime() % DAY !== 0) allMidnight = false; }
      else k = 'any';
      if (t === null) t = k; else if (t !== k) return 'any';
    }
    if (t === 'number') return allInt ? 'int' : 'number';
    if (t === 'date') return allMidnight ? 'date' : 'datetime';
    return t || 'any';
  };

  /** Infer the best target type for a raw column (samples head + random tail, as in the plan). */
  PQ.inferType = function (arr, locale) {
    const idx = [];
    const n = arr.length;
    for (let i = 0; i < Math.min(n, 300); i++) idx.push(i);
    if (n > 300) { let seed = 7; for (let k = 0; k < 300; k++) { seed = (seed * 16807) % 2147483647; idx.push(300 + (seed % (n - 300))); } }
    let seen = 0, isBool = true, isInt = true, isNum = true, isDate = true, allMidnight = true, anyString = false, allNative = true;
    for (const i of idx) {
      const v = arr[i];
      if (v === null || v === undefined || v === '' || v instanceof CellError) continue;
      seen++;
      if (typeof v === 'boolean') { isInt = isNum = isDate = false; continue; }
      if (typeof v === 'number') { isBool = false; isDate = false; if (!Number.isInteger(v)) isInt = false; continue; }
      if (v instanceof Date) { isBool = isInt = isNum = false; if (v.getTime() % DAY !== 0) allMidnight = false; continue; }
      anyString = true; allNative = false;
      const s = String(v).trim().toLowerCase();
      if (!(BOOL_T.has(s) || BOOL_F.has(s)) || /^\d+$/.test(s)) isBool = false;
      if (isNum || isInt) {
        const num = PQ.parseNumber(v, locale);
        if (num === null) { isNum = false; isInt = false; } else if (!Number.isInteger(num) || /[.,]\d*[1-9]/.test(s) && !Number.isInteger(num)) isInt = false;
      }
      if (isDate) {
        const d = PQ.parseDate(v, locale, true);
        if (!d) isDate = false; else if (d.getTime() % DAY !== 0) allMidnight = false;
      }
    }
    if (seen === 0) return anyString ? 'text' : 'any';
    if (isBool && anyString) return 'bool';
    if (isBool && !anyString && allNative && !isNum) return 'bool';
    if (isInt && isNum) return 'int';
    if (isNum) return 'number';
    if (isDate) return allMidnight ? 'date' : 'datetime';
    return 'text';
  };

  /* ---------- Formatting ---------- */
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  PQ.fmtDate = function (d, type) {
    const base = d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    if (type === 'date' || (type !== 'datetime' && d.getTime() % DAY === 0)) return base;
    return base + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
  };
  PQ.fmtValue = function (v, type) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return PQ.fmtDate(v, type);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(+v.toFixed(10));
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  };
  PQ.fmtInt = (n) => (n === Infinity ? '∞' : Number(n).toLocaleString('en-US'));

  /* ---------- Hashing (fingerprints / cache keys) ---------- */
  PQ.hash = function (str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  };
  /** Stable JSON: sorted keys (git-friendly project files, stable fingerprints). */
  PQ.stableStringify = function (obj, indent) {
    const sort = (v) => {
      if (Array.isArray(v)) return v.map(sort);
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const o = {};
        Object.keys(v).sort().forEach((k) => { if (v[k] !== undefined) o[k] = sort(v[k]); });
        return o;
      }
      return v;
    };
    return JSON.stringify(sort(obj), null, indent);
  };

  /* ---------- Parameters: {name, type: text|number|date|list, value} ---------- */
  PQ.paramValue = function (p) {
    if (!p) return null;
    if (p.type === 'number') { const n = PQ.parseNumber(p.value); return n === null ? null : n; }
    if (p.type === 'date') { const d = PQ.parseDate(p.value); return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : null; }
    if (p.type === 'list') return String(p.value || '').split(',').map((s) => s.trim()).filter(Boolean);
    return p.value === undefined ? null : String(p.value);
  };
  PQ.paramType = (p) => (p.type === 'number' ? 'number' : p.type === 'date' ? 'date' : p.type === 'list' ? 'list' : 'text');

  /* ---------- Misc helpers ---------- */
  PQ.uid = (p) => (p || 'id') + '_' + Math.random().toString(36).slice(2, 10);
  PQ.esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  PQ.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  PQ.levenshtein = function (a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  };
  PQ.closest = function (name, candidates) {
    let best = null, bd = Infinity;
    for (const c of candidates || []) {
      const dd = PQ.levenshtein(name, c);
      if (dd < bd) { bd = dd; best = c; }
    }
    return best !== null && bd <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
  };
  PQ.pyStr = (s) => JSON.stringify(String(s));
  PQ.snake = (s) => {
    const r = String(s).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
    return /^[0-9]/.test(r) || !r ? 'q_' + r : r;
  };
  PQ.globToRegex = (g) => new RegExp('^' + String(g).split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');

  /* ---------- A1 ranges ---------- */
  PQ.colToIdx = (s) => { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  PQ.idxToCol = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  /** "B3:H500", "B3:H" (to last row), "B:H", "B3", "Sheet1!$A$1:$B$5". Returns 0-based {sheet,r1,c1,r2,c2} (r2/c2 may be Infinity). */
  PQ.parseA1 = function (ref) {
    if (!ref) return null;
    let s = String(ref).trim().replace(/\$/g, ''), sheet = null;
    const bang = s.lastIndexOf('!');
    if (bang >= 0) { sheet = s.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'"); s = s.slice(bang + 1); }
    const part = (p) => { const m = /^([A-Za-z]{1,3})?(\d+)?$/.exec(p); if (!m || (!m[1] && !m[2])) return null; return { c: m[1] ? PQ.colToIdx(m[1]) : null, r: m[2] ? +m[2] - 1 : null }; };
    const [a, b] = s.split(':');
    const p1 = part(a); if (!p1) return null;
    const p2 = b !== undefined ? part(b) : p1; if (!p2) return null;
    return { sheet, c1: p1.c === null ? 0 : p1.c, r1: p1.r === null ? 0 : p1.r, c2: p2.c === null ? Infinity : p2.c, r2: p2.r === null ? Infinity : p2.r };
  };
  PQ.fmtA1 = (r) => PQ.idxToCol(r.c1) + (r.r1 + 1) + ':' + (r.c2 === Infinity ? 'XFD' : PQ.idxToCol(r.c2)) + (r.r2 === Infinity ? '' : r.r2 + 1);

  /* ---------- IndexedDB file store (stands in for the OS file system in the prototype) ---------- */
  const IDB = {
    _db: null,
    open() {
      if (this._db) return this._db;
      if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
      this._db = new Promise((res, rej) => {
        const r = indexedDB.open('pqx-files', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return this._db;
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const t = db.transaction('files', mode), st = t.objectStore('files');
        const out = fn(st);
        t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
        t.onerror = () => rej(t.error);
      });
    },
    put(rec) { return this.tx('readwrite', (s) => s.put(rec)); },
    all() { return this.tx('readonly', (s) => s.getAll()); },
    del(id) { return this.tx('readwrite', (s) => s.delete(id)); },
    clear() { return this.tx('readwrite', (s) => s.clear()); },
  };
  PQ.IDB = IDB;

  /** In-memory mirror of stored files, so the engine can stay synchronous. */
  PQ.Files = new Map();
  PQ.isLazyFile = (name) => /\.(parquet|pq)$/i.test(String(name || ''));
  PQ.addFile = async function (name, buf, extra) {
    const blob = extra && extra.blob;
    const rec = Object.assign({ id: PQ.uid('file'), name, size: buf ? buf.byteLength : blob ? blob.size : 0, mtime: Date.now(), buf: buf || null }, extra || {});
    PQ.Files.set(rec.id, rec);
    const store = IDB.put(rec).catch((e) => console.warn('IndexedDB unavailable, file kept in memory only', e));
    if (!rec.blob) await store;
    return rec;
  };
  PQ.loadFiles = async function () {
    try { (await IDB.all()).forEach((f) => PQ.Files.set(f.id, f)); } catch (e) { console.warn('IndexedDB load failed', e); }
  };
})();
