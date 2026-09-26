/* PQX formula language (mirrors crate pq-expr).
 *   if [Sales] > 1000 and [Region] = "EU" then "Key" else "Other"
 *   Text.Upper([Name]) & " (" & Text.From(Date.Year([OrderDate])) & ")"
 *   try Number.From([Amount]) otherwise 0
 *   [Region] in {"EU", "US"}
 * Pipeline: tokenize → parse (spans) → check against input schema (typed, positioned errors)
 *           → compile to a vectorised row closure (preview engine) or to a Polars Python expression (codegen). */
(function () {
  const PQ = self.PQ;
  const { CellError, isErr } = PQ;

  class FormulaError extends Error {
    constructor(msg, start, end, hint) { super(msg); this.start = start; this.end = end === undefined ? start + 1 : end; this.hint = hint; }
  }
  PQ.FormulaError = FormulaError;

  const KEYWORDS = new Set(['if', 'then', 'else', 'and', 'or', 'not', 'true', 'false', 'null', 'try', 'otherwise', 'in']);

  /* ------------------------------ Tokenizer ------------------------------ */
  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      const start = i;
      if (ch === '[') {
        let j = i + 1, name = '';
        while (j < src.length) {
          if (src[j] === ']') { if (src[j + 1] === ']') { name += ']'; j += 2; continue; } break; }
          name += src[j]; j++;
        }
        if (j >= src.length) throw new FormulaError('Unclosed column reference — add "]"', start, src.length);
        toks.push({ t: 'col', v: name.trim(), s: start, e: j + 1 }); i = j + 1; continue;
      }
      if (ch === '"') {
        let j = i + 1, str = '';
        while (j < src.length) {
          if (src[j] === '"') { if (src[j + 1] === '"') { str += '"'; j += 2; continue; } break; }
          str += src[j]; j++;
        }
        if (j >= src.length) throw new FormulaError('Unclosed text — add a closing quote (")', start, src.length);
        toks.push({ t: 'str', v: str, s: start, e: j + 1 }); i = j + 1; continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i));
        toks.push({ t: 'num', v: parseFloat(m[0]), s: start, e: i + m[0].length }); i += m[0].length; continue;
      }
      if (ch === '@') {
        const m = /^@([A-Za-z_][A-Za-z0-9_]*)/.exec(src.slice(i));
        if (!m) throw new FormulaError('Expected a parameter name after @', start, start + 1);
        toks.push({ t: 'param', v: m[1], s: start, e: i + m[0].length }); i += m[0].length; continue;
      }
      if (ch === '#' && /^#date\b/.test(src.slice(i))) { toks.push({ t: 'ident', v: '#date', s: start, e: i + 5 }); i += 5; continue; }
      if (/[A-Za-z_]/.test(ch)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(src.slice(i));
        const w = m[0];
        if (KEYWORDS.has(w.toLowerCase()) && w.indexOf('.') < 0) toks.push({ t: 'kw', v: w.toLowerCase(), s: start, e: i + w.length });
        else toks.push({ t: 'ident', v: w, s: start, e: i + w.length });
        i += w.length; continue;
      }
      const two = src.slice(i, i + 2);
      if (['<>', '<=', '>=', '!=', '=='].includes(two)) { toks.push({ t: 'op', v: two === '!=' ? '<>' : two === '==' ? '=' : two, s: start, e: i + 2 }); i += 2; continue; }
      if ('+-*/&=<>(),{}'.includes(ch)) { toks.push({ t: 'op', v: ch, s: start, e: i + 1 }); i++; continue; }
      throw new FormulaError('Unexpected character "' + ch + '"', start, start + 1);
    }
    toks.push({ t: 'eof', v: null, s: src.length, e: src.length });
    return toks;
  }

  /* ------------------------------ Parser (Pratt) ------------------------------ */
  const BIN = { or: 1, and: 2, '=': 4, '<>': 4, '<': 4, '>': 4, '<=': 4, '>=': 4, in: 4, '+': 5, '-': 5, '&': 5, '*': 6, '/': 6 };

  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    const isOp = (v) => (peek().t === 'op' || peek().t === 'kw') && peek().v === v;
    const expect = (v, what) => {
      const t = peek();
      if ((t.t === 'op' || t.t === 'kw') && t.v === v) return next();
      throw new FormulaError('Expected ' + (what || '"' + v + '"') + (t.t === 'eof' ? ' but the formula ended' : ' but found "' + src.slice(t.s, t.e) + '"'), t.s, Math.max(t.e, t.s + 1));
    };

    function primary() {
      const t = peek();
      if (t.t === 'num') { next(); return { k: 'lit', v: t.v, s: t.s, e: t.e }; }
      if (t.t === 'str') { next(); return { k: 'lit', v: t.v, s: t.s, e: t.e }; }
      if (t.t === 'param') { next(); return { k: 'param', name: t.v, s: t.s, e: t.e }; }
      if (t.t === 'col') { next(); if (!t.v) throw new FormulaError('Empty column reference []', t.s, t.e); return { k: 'col', name: t.v, s: t.s, e: t.e }; }
      if (t.t === 'kw') {
        if (t.v === 'true' || t.v === 'false') { next(); return { k: 'lit', v: t.v === 'true', s: t.s, e: t.e }; }
        if (t.v === 'null') { next(); return { k: 'lit', v: null, s: t.s, e: t.e }; }
        if (t.v === 'if') {
          next();
          const c = expr(0); expect('then', '"then"');
          const a = expr(0); expect('else', '"else" (every if needs an else)');
          const b = expr(0);
          return { k: 'if', c, a, b, s: t.s, e: b.e };
        }
        if (t.v === 'try') {
          next();
          const a = expr(0);
          let b = { k: 'lit', v: null, s: a.e, e: a.e };
          if (isOp('otherwise')) { next(); b = expr(0); }
          return { k: 'try', a, b, s: t.s, e: b.e };
        }
        if (t.v === 'not') { next(); const a = expr(3); return { k: 'un', op: 'not', a, s: t.s, e: a.e }; }
      }
      if (t.t === 'op' && t.v === '-') { next(); const a = expr(7); return { k: 'un', op: '-', a, s: t.s, e: a.e }; }
      if (t.t === 'op' && t.v === '+') { next(); return expr(7); }
      if (t.t === 'op' && t.v === '(') { next(); const a = expr(0); expect(')', 'a closing ")"'); return a; }
      if (t.t === 'op' && t.v === '{') {
        next(); const items = [];
        if (!isOp('}')) { do { items.push(expr(0)); } while (isOp(',') && next()); }
        const end = expect('}', 'a closing "}"');
        return { k: 'list', items, s: t.s, e: end.e };
      }
      if (t.t === 'ident') {
        next();
        if (!isOp('(')) {
          const hint = PQ.FUNCS[t.v] ? 'Add parentheses: ' + t.v + '(...)' : 'Column names go in square brackets: [' + t.v + ']';
          throw new FormulaError('Unknown name "' + t.v + '"', t.s, t.e, hint);
        }
        next(); const args = [];
        if (!isOp(')')) { do { args.push(expr(0)); } while (isOp(',') && next()); }
        const end = expect(')', 'a closing ")" for ' + t.v);
        return { k: 'call', fn: t.v, args, s: t.s, e: end.e, fs: t.s, fe: t.e };
      }
      if (t.t === 'eof') throw new FormulaError('The formula is incomplete', t.s, t.s + 1);
      throw new FormulaError('Unexpected "' + src.slice(t.s, t.e) + '"', t.s, t.e);
    }

    function expr(minPrec) {
      let left = primary();
      for (;;) {
        const t = peek();
        if (!(t.t === 'op' || t.t === 'kw')) break;
        const prec = BIN[t.v];
        if (!prec || prec <= minPrec) break;
        next();
        const right = expr(prec);
        left = { k: 'bin', op: t.v, a: left, b: right, s: left.s, e: right.e, os: t.s, oe: t.e };
      }
      return left;
    }

    const ast = expr(0);
    if (peek().t !== 'eof') { const t = peek(); throw new FormulaError('Unexpected "' + src.slice(t.s, t.e) + '" — did you forget an operator such as "and" or "&"?', t.s, t.e); }
    return ast;
  }

  /* ------------------------------ Runtime helpers ------------------------------ */
  const DAY = 86400000;
  const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : v === null ? null : (() => { const n = PQ.parseNumber(v, 'en-US'); return n === null ? new CellError('Expected a number but got "' + v + '"', v) : n; })());
  const txt = (v) => (v === null ? null : v instanceof Date ? PQ.fmtDate(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v));
  const dt = (v) => (v instanceof Date ? v : v === null ? null : PQ.parseDate(v, 'en-US') || new CellError('Expected a date but got "' + v + '"', v));
  function cmp(a, b) {
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    if (a instanceof Date && typeof b === 'string') { const d = PQ.parseDate(b); if (d) return a - d; }
    if (typeof a === 'string' && b instanceof Date) { const d = PQ.parseDate(a); if (d) return d - b; }
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    if (typeof a === 'boolean' && typeof b === 'boolean') return +a - +b;
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  }
  function eq(a, b) {
    if (a === null || b === null) return a === b;
    if (a instanceof Date || b instanceof Date) return cmp(a, b) === 0;
    if (typeof a === 'number' && typeof b === 'string') { const n = PQ.parseNumber(b); return n !== null && n === a; }
    if (typeof a === 'string' && typeof b === 'number') { const n = PQ.parseNumber(a); return n !== null && n === b; }
    return a === b;
  }
  PQ.valueEquals = eq;
  PQ.valueCompare = cmp;
  const addMonths = (d, n) => {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + n, day = d.getUTCDate();
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return new Date(Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  };
  const isoWeek = (d) => {
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const dayNum = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - dayNum);
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / DAY + 1) / 7);
  };
  const MONTHN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOWN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const roundHalfEven = (x, d) => { const f = Math.pow(10, d || 0); const v = x * f; const r = Math.round(v); return (Math.abs(v % 1) === 0.5 ? 2 * Math.round(v / 2) : r) / f; };

  /* ------------------------------ Function registry (drives compile + autocomplete + codegen) ------------------------------ */
  // sig: arg kinds (t=text, n=number, d=date, a=any, '?' suffix optional, '...' variadic); ret: type or 'arg0'
  const F = {};
  const def = (name, sig, ret, doc, impl, py) => { F[name] = { name, sig, ret, doc, impl, py }; };
  const P = (a) => a; // readability

  // Text
  def('Text.Upper', ['t'], 'text', 'Converts text to upper case', (s) => s.toUpperCase(), (a) => `${a[0]}.str.to_uppercase()`);
  def('Text.Lower', ['t'], 'text', 'Converts text to lower case', (s) => s.toLowerCase(), (a) => `${a[0]}.str.to_lowercase()`);
  def('Text.Proper', ['t'], 'text', 'Capitalises the first letter of every word', (s) => s.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (m, p, c) => p + c.toUpperCase()), (a) => `${a[0]}.str.to_titlecase()`);
  def('Text.Trim', ['t'], 'text', 'Removes leading and trailing whitespace', (s) => s.trim(), (a) => `${a[0]}.str.strip_chars()`);
  def('Text.Clean', ['t'], 'text', 'Removes control characters and collapses repeated spaces', (s) => s.replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim(), (a) => `${a[0]}.str.replace_all(r"[\\x00-\\x1f\\x7f]", "").str.replace_all(r"\\s+", " ").str.strip_chars()`);
  def('Text.Length', ['t'], 'int', 'Number of characters', (s) => s.length, (a) => `${a[0]}.str.len_chars()`);
  def('Text.Start', ['t', 'n'], 'text', 'First N characters', (s, n) => s.slice(0, n), (a) => `${a[0]}.str.slice(0, ${a[1]})`);
  def('Text.End', ['t', 'n'], 'text', 'Last N characters', (s, n) => (n <= 0 ? '' : s.slice(-n)), (a) => `${a[0]}.str.tail(${a[1]})`);
  def('Text.Middle', ['t', 'n', 'n?'], 'text', 'Characters from a 0-based offset, optionally limited to a count', (s, o, c) => (c === undefined || c === null ? s.slice(o) : s.substr(o, c)), (a) => `${a[0]}.str.slice(${a[1]}${a[2] ? ', ' + a[2] : ''})`);
  def('Text.Contains', ['t', 't'], 'bool', 'True if the text contains the substring (case-sensitive)', (s, x) => s.includes(x), (a) => `${a[0]}.str.contains(${a[1]}, literal=True)`);
  def('Text.StartsWith', ['t', 't'], 'bool', 'True if the text starts with the substring', (s, x) => s.startsWith(x), (a) => `${a[0]}.str.starts_with(${a[1]})`);
  def('Text.EndsWith', ['t', 't'], 'bool', 'True if the text ends with the substring', (s, x) => s.endsWith(x), (a) => `${a[0]}.str.ends_with(${a[1]})`);
  def('Text.Replace', ['t', 't', 't'], 'text', 'Replaces every occurrence of a substring', (s, a, b) => (a === '' ? s : s.split(a).join(b)), (a) => `${a[0]}.str.replace_all(${a[1]}, ${a[2]}, literal=True)`);
  def('Text.PadStart', ['t', 'n', 't?'], 'text', 'Pads the start to a length (default pad " ")', (s, n, c) => s.padStart(n, c || ' '), (a) => `${a[0]}.str.pad_start(${a[1]}${a[2] ? ', ' + a[2] : ''})`);
  def('Text.PadEnd', ['t', 'n', 't?'], 'text', 'Pads the end to a length', (s, n, c) => s.padEnd(n, c || ' '), (a) => `${a[0]}.str.pad_end(${a[1]}${a[2] ? ', ' + a[2] : ''})`);
  def('Text.BeforeDelimiter', ['t', 't'], 'text', 'Text before the first delimiter', (s, d) => { const i = s.indexOf(d); return i < 0 ? s : s.slice(0, i); }, (a) => `${a[0]}.str.split(${a[1]}).list.first()`);
  def('Text.AfterDelimiter', ['t', 't'], 'text', 'Text after the first delimiter', (s, d) => { const i = s.indexOf(d); return i < 0 ? '' : s.slice(i + d.length); }, (a) => `${a[0]}.str.splitn(${a[1]}, 2).struct.field("field_1")`);
  def('Text.Repeat', ['t', 'n'], 'text', 'Repeats text N times', (s, n) => s.repeat(Math.max(0, n)), (a) => `pl.concat_str([${a[0]}] * ${a[1]})`);
  def('Text.From', ['a'], 'text', 'Converts any value to text', (v) => txt(v), (a) => `${a[0]}.cast(pl.String)`, true);
  def('Text.Combine', ['a...'], 'text', 'Joins values, skipping nulls: Text.Combine([A], " ", [B])', null, (a) => `pl.concat_str([${a.join(', ')}], ignore_nulls=True)`);
  // Number
  def('Number.Round', ['n', 'n?'], 'number', 'Rounds to N digits (banker\'s rounding, like Power Query)', (x, d) => roundHalfEven(x, d || 0), (a) => `${a[0]}.round(${a[1] || 0})`);
  def('Number.RoundUp', ['n'], 'int', 'Ceiling', (x) => Math.ceil(x), (a) => `${a[0]}.ceil()`);
  def('Number.RoundDown', ['n'], 'int', 'Floor', (x) => Math.floor(x), (a) => `${a[0]}.floor()`);
  def('Number.Abs', ['n'], 'arg0', 'Absolute value', (x) => Math.abs(x), (a) => `${a[0]}.abs()`);
  def('Number.Sign', ['n'], 'int', '-1, 0 or 1', (x) => Math.sign(x), (a) => `${a[0]}.sign()`);
  def('Number.Mod', ['n', 'n'], 'number', 'Remainder of a division', (x, y) => (y === 0 ? new CellError('Division by zero') : ((x % y) + y) % y), (a) => `${a[0]} % ${a[1]}`);
  def('Number.IntegerDivide', ['n', 'n'], 'int', 'Whole-number division', (x, y) => (y === 0 ? new CellError('Division by zero') : Math.floor(x / y)), (a) => `${a[0]} // ${a[1]}`);
  def('Number.Power', ['n', 'n'], 'number', 'x to the power of y', (x, y) => Math.pow(x, y), (a) => `${a[0]}.pow(${a[1]})`);
  def('Number.Sqrt', ['n'], 'number', 'Square root', (x) => (x < 0 ? new CellError('Square root of a negative number') : Math.sqrt(x)), (a) => `${a[0]}.sqrt()`);
  def('Number.Log', ['n'], 'number', 'Natural logarithm', (x) => (x <= 0 ? new CellError('Log of a non-positive number') : Math.log(x)), (a) => `${a[0]}.log()`);
  def('Number.From', ['a'], 'number', 'Converts text, booleans or dates to a number (lenient: "1,234", "(5)", "12%")', (v) => (v instanceof Date ? PQ.dateToExcelSerial(v) : num(v)), (a) => `${a[0]}.cast(pl.Float64, strict=False)`, true);
  // Date
  def('Date.Year', ['d'], 'int', 'Year', (d) => d.getUTCFullYear(), (a) => `${a[0]}.dt.year()`);
  def('Date.Month', ['d'], 'int', 'Month number 1–12', (d) => d.getUTCMonth() + 1, (a) => `${a[0]}.dt.month()`);
  def('Date.Day', ['d'], 'int', 'Day of month', (d) => d.getUTCDate(), (a) => `${a[0]}.dt.day()`);
  def('Date.Quarter', ['d'], 'int', 'Quarter 1–4', (d) => Math.floor(d.getUTCMonth() / 3) + 1, (a) => `${a[0]}.dt.quarter()`);
  def('Date.WeekOfYear', ['d'], 'int', 'ISO week number', (d) => isoWeek(d), (a) => `${a[0]}.dt.week()`);
  def('Date.DayOfWeek', ['d'], 'int', 'Day of week, Monday = 1 … Sunday = 7 (ISO)', (d) => d.getUTCDay() || 7, (a) => `${a[0]}.dt.weekday()`);
  def('Date.MonthName', ['d'], 'text', 'Month name, e.g. "March"', (d) => MONTHN[d.getUTCMonth()], (a) => `${a[0]}.dt.strftime("%B")`);
  def('Date.DayOfWeekName', ['d'], 'text', 'Weekday name, e.g. "Monday"', (d) => DOWN[d.getUTCDay()], (a) => `${a[0]}.dt.strftime("%A")`);
  def('Date.AddDays', ['d', 'n'], 'arg0', 'Adds N days', (d, n) => new Date(d.getTime() + n * DAY), (a) => `${a[0]} + pl.duration(days=${a[1]})`);
  def('Date.AddMonths', ['d', 'n'], 'arg0', 'Adds N months (clamps to month end)', (d, n) => addMonths(d, n), (a) => `${a[0]}.dt.offset_by(pl.format("{}mo", ${a[1]}))`);
  def('Date.StartOfMonth', ['d'], 'date', 'First day of the month', (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)), (a) => `${a[0]}.dt.month_start()`);
  def('Date.EndOfMonth', ['d'], 'date', 'Last day of the month', (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)), (a) => `${a[0]}.dt.month_end()`);
  def('Date.DiffDays', ['d', 'd'], 'int', 'Whole days from the first date to the second', (a, b) => Math.round((b - a) / DAY), (a) => `(${a[1]} - ${a[0]}).dt.total_days()`);
  def('Date.From', ['a'], 'date', 'Converts text or an Excel serial number to a date', (v) => { const d = PQ.parseDate(v); return d ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) : new CellError('Cannot convert "' + v + '" to a date', v); }, (a) => `${a[0]}.str.to_date(strict=False)`, true);
  def('Date.ToText', ['d', 't?'], 'text', 'Formats a date: tokens yyyy, MM, dd, MMM', (d, f) => {
    f = f || 'yyyy-MM-dd'; const p = (n) => String(n).padStart(2, '0');
    return f.replace(/yyyy|MMMM|MMM|MM|dd|HH|mm|ss/g, (t) => ({ yyyy: d.getUTCFullYear(), MMMM: MONTHN[d.getUTCMonth()], MMM: MONTHN[d.getUTCMonth()].slice(0, 3), MM: p(d.getUTCMonth() + 1), dd: p(d.getUTCDate()), HH: p(d.getUTCHours()), mm: p(d.getUTCMinutes()), ss: p(d.getUTCSeconds()) }[t]));
  }, (a) => `${a[0]}.dt.strftime(${a[1] ? a[1].replace(/yyyy/g, '%Y').replace(/MMMM/g, '%B').replace(/MMM/g, '%b').replace(/MM/g, '%m').replace(/dd/g, '%d') : '"%Y-%m-%d"'})`);
  def('#date', ['n', 'n', 'n'], 'date', 'Date literal: #date(2026, 9, 26)', (y, m, d) => new Date(Date.UTC(y, m - 1, d)), (a) => `pl.date(${a.join(', ')})`);
  // Logical / misc
  def('Coalesce', ['a...'], 'arg0', 'First non-null value', null, (a) => `pl.coalesce(${a.join(', ')})`);
  def('Value.IsNull', ['a'], 'bool', 'True if the value is null', null, (a) => `${a[0]}.is_null()`);
  def('Value.IsError', ['a'], 'bool', 'True if the value is an error', null, (a) => `pl.lit(False)`);
  def('List.Contains', ['L', 'a'], 'bool', 'True if the list contains the value: List.Contains({"EU","US"}, [Region])', null, (a) => `${a[1]}.is_in(${a[0]})`);
  PQ.FUNCS = F;

  /* ------------------------------ Type checking ------------------------------ */
  const KIND_OK = { t: ['text', 'any'], n: ['number', 'int', 'any', 'bool'], d: ['date', 'datetime', 'any', 'text'] };
  const isNumT = (t) => t === 'number' || t === 'int';

  /** Returns {type, cols:Set} or throws FormulaError. schema: [{name,type}] */
  function check(ast, schema, params) {
    const types = new Map(schema.map((c) => [c.name, c.type]));
    const ptypes = new Map((params || []).map((p) => [p.name, p.type]));
    const used = new Set();
    function go(n) {
      switch (n.k) {
        case 'lit': return n.v === null ? 'any' : typeof n.v === 'number' ? (Number.isInteger(n.v) ? 'int' : 'number') : typeof n.v === 'boolean' ? 'bool' : 'text';
        case 'list': n.items.forEach(go); return 'list';
        case 'param': {
          if (!ptypes.has(n.name)) {
            const sug = PQ.closest(n.name, [...ptypes.keys()]);
            throw new FormulaError('Parameter @' + n.name + ' is not defined', n.s, n.e, sug ? 'Did you mean @' + sug + '?' : 'Create it in Parameters (toolbar)');
          }
          return ptypes.get(n.name);
        }
        case 'col': {
          if (!types.has(n.name)) {
            const sug = PQ.closest(n.name, [...types.keys()]);
            throw new FormulaError('Column [' + n.name + '] not found', n.s, n.e, sug ? 'Did you mean [' + sug + ']?' : 'Available: ' + [...types.keys()].slice(0, 8).map((x) => '[' + x + ']').join(', '));
          }
          used.add(n.name);
          return types.get(n.name);
        }
        case 'un': { const t = go(n.a); return n.op === 'not' ? 'bool' : t; }
        case 'if': { const c = go(n.c); if (c !== 'bool' && c !== 'any') throw new FormulaError('The condition after "if" must be True/False, but it is ' + PQ.TYPES[c].label, n.c.s, n.c.e, 'Compare it, e.g. [x] > 0 or [x] = "A"'); const a = go(n.a), b = go(n.b); return a === b ? a : n.b.k === 'lit' && n.b.v === null ? a : n.a.k === 'lit' && n.a.v === null ? b : isNumT(a) && isNumT(b) ? 'number' : 'any'; }
        case 'try': { const a = go(n.a); go(n.b); return a; }
        case 'bin': {
          const a = go(n.a), b = go(n.b);
          switch (n.op) {
            case 'and': case 'or': case '=': case '<>': case '<': case '>': case '<=': case '>=': return 'bool';
            case 'in': if (n.b.k !== 'list') throw new FormulaError('"in" needs a list on the right, e.g. [Region] in {"EU", "US"}', n.b.s, n.b.e); return 'bool';
            case '&': return 'text';
            case '+': case '-':
              if (a === 'text' || b === 'text') throw new FormulaError('Cannot ' + (n.op === '+' ? 'add' : 'subtract') + ' text', n.os, n.oe, n.op === '+' ? 'Use & to join text: [A] & " " & [B]' : 'Convert first with Number.From(...)');
              if ((a === 'date' || a === 'datetime') && isNumT(b)) return a;
              if ((a === 'date' || a === 'datetime') && (b === 'date' || b === 'datetime') && n.op === '-') return 'int';
              return a === 'int' && b === 'int' ? 'int' : 'number';
            case '*': case '/':
              if (a === 'text' || b === 'text') throw new FormulaError('Cannot ' + (n.op === '*' ? 'multiply' : 'divide') + ' text', n.os, n.oe, 'Change the column type to a number first, or use Number.From(...)');
              return n.op === '*' && a === 'int' && b === 'int' ? 'int' : 'number';
          }
          return 'any';
        }
        case 'call': {
          const f = F[n.fn];
          if (!f) {
            const sug = PQ.closest(n.fn, Object.keys(F));
            throw new FormulaError('Unknown function ' + n.fn, n.fs, n.fe, sug ? 'Did you mean ' + sug + '?' : 'Press Ctrl+Space for the function list');
          }
          const variadic = f.sig.some((s) => s.endsWith('...'));
          const req = f.sig.filter((s) => !s.endsWith('?') && !s.endsWith('...')).length;
          if (n.args.length < Math.max(req, variadic ? 1 : 0) || (!variadic && n.args.length > f.sig.length))
            throw new FormulaError(n.fn + ' expects ' + (variadic ? 'one or more' : req === f.sig.length ? req : req + '–' + f.sig.length) + ' argument(s), got ' + n.args.length, n.s, n.e, f.doc);
          const at = n.args.map(go);
          n.args.forEach((arg, i) => {
            const k = (f.sig[i] || f.sig[f.sig.length - 1]).replace(/[?.]/g, '');
            if (k === 'L') { if (arg.k !== 'list') throw new FormulaError('First argument must be a list like {"A", "B"}', arg.s, arg.e); return; }
            if (KIND_OK[k] && !KIND_OK[k].includes(at[i]) && !(arg.k === 'lit' && arg.v === null)) {
              const want = { t: 'text', n: 'a number', d: 'a date' }[k];
              const conv = { t: 'Text.From', n: 'Number.From', d: 'Date.From' }[k];
              throw new FormulaError(n.fn + ' needs ' + want + ' but argument ' + (i + 1) + ' is ' + PQ.TYPES[at[i]].label, arg.s, arg.e, 'Wrap it: ' + conv + '(...)');
            }
          });
          return f.ret === 'arg0' ? (at[0] || 'any') : f.ret;
        }
      }
      return 'any';
    }
    const type = go(ast);
    return { type, cols: used };
  }

  /* ------------------------------ Compile to row closure ------------------------------ */
  function compileRow(ast, table, params) {
    function go(n) {
      switch (n.k) {
        case 'lit': { const v = n.v; return () => v; }
        case 'param': { const p = (params || []).find((x) => x.name === n.name); const v = p ? PQ.paramValue(p) : null; return () => v; }
        case 'list': { const f = n.items.map(go); return (r) => f.map((g) => g(r)); }
        case 'col': { const arr = table.get(n.name); return (r) => arr[r]; }
        case 'un': {
          const a = go(n.a);
          if (n.op === 'not') return (r) => { const v = a(r); return isErr(v) ? v : v === null ? null : !v; };
          return (r) => { const v = a(r); if (v === null || isErr(v)) return v; const x = num(v); return isErr(x) ? x : -x; };
        }
        case 'if': { const c = go(n.c), a = go(n.a), b = go(n.b); return (r) => { const v = c(r); if (isErr(v)) return v; return v === true ? a(r) : b(r); }; }
        case 'try': { const a = go(n.a), b = go(n.b); return (r) => { let v; try { v = a(r); } catch (e) { v = new CellError(e.message); } return isErr(v) ? b(r) : v; }; }
        case 'bin': {
          const a = go(n.a), b = go(n.b), op = n.op;
          if (op === 'and') return (r) => { const x = a(r); if (isErr(x)) return x; if (x === false) return false; const y = b(r); if (isErr(y)) return y; if (y === false) return false; return x === null || y === null ? null : true; };
          if (op === 'or') return (r) => { const x = a(r); if (isErr(x)) return x; if (x === true) return true; const y = b(r); if (isErr(y)) return y; if (y === true) return true; return x === null || y === null ? null : false; };
          if (op === 'in') return (r) => { const x = a(r); if (isErr(x)) return x; return b(r).some((y) => eq(x, y)); };
          return (r) => {
            const x = a(r), y = b(r);
            if (isErr(x)) return x; if (isErr(y)) return y;
            switch (op) {
              case '=': return eq(x, y);
              case '<>': return !eq(x, y);
              case '&': return x === null && y === null ? null : (txt(x) || '') + (txt(y) || '');
            }
            if (x === null || y === null) return null;
            switch (op) {
              case '<': return cmp(x, y) < 0;
              case '>': return cmp(x, y) > 0;
              case '<=': return cmp(x, y) <= 0;
              case '>=': return cmp(x, y) >= 0;
            }
            if (x instanceof Date) {
              if (op === '-' && y instanceof Date) return Math.round((x - y) / DAY);
              const k = num(y); if (isErr(k)) return k;
              if (op === '+') return new Date(x.getTime() + k * DAY);
              if (op === '-') return new Date(x.getTime() - k * DAY);
            }
            const p = num(x), q = num(y);
            if (isErr(p)) return p; if (isErr(q)) return q;
            switch (op) {
              case '+': return p + q;
              case '-': return p - q;
              case '*': return p * q;
              case '/': return q === 0 ? new CellError('Division by zero') : p / q;
            }
            return null;
          };
        }
        case 'call': {
          const f = F[n.fn], args = n.args.map(go);
          if (n.fn === 'Coalesce') return (r) => { for (const g of args) { const v = g(r); if (v !== null && !isErr(v)) return v; } return null; };
          if (n.fn === 'Value.IsNull') return (r) => args[0](r) === null;
          if (n.fn === 'Value.IsError') return (r) => isErr(args[0](r));
          if (n.fn === 'List.Contains') return (r) => { const x = args[1](r); if (isErr(x)) return x; return args[0](r).some((y) => eq(x, y)); };
          if (n.fn === 'Text.Combine') return (r) => { const vs = args.map((g) => g(r)); const e = vs.find(isErr); if (e) return e; return vs.filter((v) => v !== null).map(txt).join(''); };
          const kinds = n.args.map((_, i) => (f.sig[i] || f.sig[f.sig.length - 1]).replace(/[?.]/g, ''));
          const anyOk = f.py && F[n.fn] && F[n.fn].impl && f.sig[0] === 'a';
          return (r) => {
            const vs = new Array(args.length);
            for (let i = 0; i < args.length; i++) {
              let v = args[i](r);
              if (isErr(v)) return v;
              if (v === null) { if (anyOk) return null; if (kinds[i] === 'n' && f.sig[i] && f.sig[i].endsWith('?')) { vs[i] = null; continue; } return null; }
              if (kinds[i] === 't') v = txt(v);
              else if (kinds[i] === 'n') { v = num(v); if (isErr(v)) return v; }
              else if (kinds[i] === 'd') { v = dt(v); if (isErr(v)) return v; }
              vs[i] = v;
            }
            try { const out = f.impl.apply(null, vs); return out === undefined ? null : typeof out === 'number' && !isFinite(out) ? new CellError('Result is not a finite number') : out; }
            catch (e) { return new CellError(e.message); }
          };
        }
      }
      return () => null;
    }
    return go(ast);
  }

  /* ------------------------------ Compile to Polars Python ------------------------------ */
  function toPython(ast, types) {
    types = types || {};
    function go(n) {
      switch (n.k) {
        case 'lit': return n.v === null ? 'pl.lit(None)' : typeof n.v === 'boolean' ? `pl.lit(${n.v ? 'True' : 'False'})` : `pl.lit(${typeof n.v === 'string' ? PQ.pyStr(n.v) : n.v})`;
        case 'list': return '[' + n.items.map((i) => (i.k === 'lit' ? (typeof i.v === 'string' ? PQ.pyStr(i.v) : String(i.v)) : go(i))).join(', ') + ']';
        case 'col': return `pl.col(${PQ.pyStr(n.name)})`;
        case 'param': return `pl.lit(PARAMS[${PQ.pyStr(n.name)}])`;
        case 'un': return n.op === 'not' ? `~(${go(n.a)})` : `-(${go(n.a)})`;
        case 'if': {
          let s = `pl.when(${go(n.c)}).then(${go(n.a)})`, b = n.b;
          while (b.k === 'if') { s += `.when(${go(b.c)}).then(${go(b.a)})`; b = b.b; }
          return s + `.otherwise(${go(b)})`;
        }
        case 'try': return `pl.coalesce(${go(n.a)}, ${go(n.b)})`;
        case 'bin': {
          const a = go(n.a), b = go(n.b);
          const map = { and: '&', or: '|', '=': '==', '<>': '!=' };
          if (n.op === '&') return `pl.concat_str([${a}, ${b}], ignore_nulls=True)`;
          if (n.op === 'in') return `${a}.is_in(${b})`;
          return `(${a} ${map[n.op] || n.op} ${b})`;
        }
        case 'call': {
          const f = F[n.fn];
          const args = n.args.map((x) => (x.k === 'lit' && typeof x.v !== 'boolean' && x.v !== null && !(n.fn === 'Coalesce' || n.fn === 'Text.Combine') ? (typeof x.v === 'string' ? PQ.pyStr(x.v) : String(x.v)) : go(x)));
          return f.py(args);
        }
      }
      return 'pl.lit(None)';
    }
    return go(ast);
  }

  /* ------------------------------ Public API ------------------------------ */
  const cache = new Map();
  PQ.Formula = {
    parse(src) {
      if (cache.has(src)) { const c = cache.get(src); if (c instanceof Error) throw c; return c; }
      try { const ast = parse(src); cache.set(src, ast); return ast; } catch (e) { cache.set(src, e); throw e; }
    },
    check(src, schema, params) { const ast = this.parse(src); return check(ast, schema, params); },
    /** Evaluate for every row. Returns {values, type}. */
    evaluate(src, table, params) {
      const ast = this.parse(src);
      const { type } = check(ast, table.schema(), params);
      const f = compileRow(ast, table, params);
      const out = new Array(table.n);
      for (let r = 0; r < table.n; r++) { try { out[r] = f(r); } catch (e) { out[r] = new CellError(e.message); } }
      let t = type;
      if (t === 'any' || t === 'list') t = PQ.valuesType(out);
      return { values: out, type: t };
    },
    toPython(src) { return toPython(this.parse(src)); },
    /** Validate for the editor. Returns null or {message,start,end,hint}. */
    validate(src, schema, params) {
      if (!src || !src.trim()) return { message: 'Enter a formula', start: 0, end: 0 };
      try { const r = this.check(src, schema, params); return { ok: true, type: r.type }; }
      catch (e) { if (e instanceof FormulaError) return { message: e.message, start: e.start, end: e.end, hint: e.hint }; return { message: e.message, start: 0, end: src.length }; }
    },
    /** Columns referenced (for dependency / rename tracking). */
    columns(src) {
      const out = new Set();
      try { (function walk(n) { if (!n || typeof n !== 'object') return; if (n.k === 'col') out.add(n.name); Object.values(n).forEach((v) => (Array.isArray(v) ? v.forEach(walk) : typeof v === 'object' && walk(v))); })(this.parse(src)); } catch (e) { /* ignore */ }
      return out;
    },
    /** Tokens for syntax highlighting (never throws). */
    highlight(src) {
      const out = [];
      const re = /(\/\/[^\n]*)|(\[(?:[^\]]|\]\])*\]?)|("(?:[^"]|"")*"?)|(\d+\.?\d*)|(#date|[A-Za-z_][A-Za-z0-9_.]*)|(\s+)|(@[A-Za-z0-9_]*)|([\s\S])/g;
      let m;
      while ((m = re.exec(src))) {
        let cls = null;
        if (m[7]) cls = 'param';
        else if (m[1]) cls = 'cmt'; else if (m[2]) cls = 'col'; else if (m[3]) cls = 'str'; else if (m[4]) cls = 'num';
        else if (m[5]) cls = KEYWORDS.has(m[5].toLowerCase()) ? 'kw' : F[m[5]] ? 'fn' : 'id';
        else if (m[8]) cls = 'op';
        out.push({ text: m[0], cls });
      }
      return out;
    },
    quoteCol: (name) => '[' + String(name).replace(/\]/g, ']]') + ']',
    lit(v) {
      if (v === null || v === undefined || v === '') return 'null';
      if (typeof v === 'number') return String(v);
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (v instanceof Date) return '#date(' + v.getUTCFullYear() + ', ' + (v.getUTCMonth() + 1) + ', ' + v.getUTCDate() + ')';
      return '"' + String(v).replace(/"/g, '""') + '"';
    },
  };
})();
