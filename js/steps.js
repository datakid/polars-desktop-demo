/* Step catalog and Polars Python code generation.
 * Shared by the UI thread and the engine worker. Pure functions only. */
(function () {
  const PQ = self.PQ;
  const S = (PQ.Steps = {});

  const cols = (a) => (a || []).map((c) => '`' + c + '`').join(', ');
  const short = (a, n) => { a = a || []; return a.length > (n || 3) ? cols(a.slice(0, n || 3)) + ' +' + (a.length - (n || 3)) : cols(a); };

  /** label, icon, describe(kind), lazy: false when the step forces materialization (Pivot/Transpose… in Polars). */
  S.CATALOG = {
    Source: { label: 'Source', icon: 'fa-database', describe: (k) => { const s = k.source || {}; if (s.kind === 'file') return (s.fileName || 'file') + (s.columns && s.columns.length ? ' · ' + s.columns.length + ' column' + (s.columns.length === 1 ? '' : 's') : '') + (s.item ? ' › ' + (s.item.type === 'sheets' ? 'sheets "' + s.item.pattern + '"' : s.item.name || s.item.sheet || '') + (s.item.range ? '!' + s.item.range : '') : ''); if (s.kind === 'folder') return 'Folder ' + s.folder + '/' + (s.pattern || '*'); if (s.kind === 'query') return 'Reference to ' + (PQ.queryName ? PQ.queryName(s.query) : s.query); return 'Entered data'; } },
    SelectColumns: { label: 'Choose Columns', icon: 'fa-table-columns', describe: (k) => 'Keep ' + short(k.cols) },
    ReorderColumns: { label: 'Reordered Columns', icon: 'fa-arrows-left-right', describe: (k) => 'Move ' + short(k.cols) + ' to the front' },
    RemoveColumns: { label: 'Removed Columns', icon: 'fa-delete-left', describe: (k) => 'Remove ' + short(k.cols) },
    Rename: { label: 'Renamed Columns', icon: 'fa-i-cursor', describe: (k) => (k.map || []).map((p) => '`' + p[0] + '` → `' + p[1] + '`').slice(0, 2).join(', ') + ((k.map || []).length > 2 ? ' …' : '') },
    ChangeType: { label: 'Changed Type', icon: 'fa-shapes', describe: (k) => (k.changes || []).map((c) => '`' + c.col + '` → ' + (PQ.TYPES[c.type] || {}).label).slice(0, 2).join(', ') + ((k.changes || []).length > 2 ? ' …' : '') + (k.onError && k.onError !== 'error' ? ' (on error: ' + k.onError + ')' : '') },
    Filter: { label: 'Filtered Rows', icon: 'fa-filter', describe: (k) => PQ.Engine ? PQ.Engine.filterFormula(k) : k.formula || '' },
    Sort: { label: 'Sorted Rows', icon: 'fa-arrow-down-wide-short', lazy: false, describe: (k) => (k.by || []).map((b) => '`' + b.col + '` ' + (b.desc ? '↓' : '↑')).join(', ') },
    Distinct: { label: 'Removed Duplicates', icon: 'fa-clone', lazy: false, describe: (k) => (k.subset && k.subset.length ? 'by ' + short(k.subset) : 'all columns') },
    KeepDuplicates: { label: 'Kept Duplicates', icon: 'fa-copy', describe: (k) => (k.subset && k.subset.length ? 'by ' + short(k.subset) : 'all columns') },
    KeepRows: { label: 'Kept Rows', icon: 'fa-list-ol', describe: (k) => ({ top: 'Top ' + k.n, bottom: 'Bottom ' + k.n, range: 'Rows ' + ((+k.offset || 0) + 1) + '–' + ((+k.offset || 0) + (+k.n || 0)), remove_top: 'Remove top ' + k.n, remove_bottom: 'Remove bottom ' + k.n, alternate: 'Alternate: keep ' + k.keep + ', skip ' + k.skip, remove_blank: 'Remove blank rows' }[k.mode] || k.mode) },
    PromoteHeaders: { label: 'Promoted Headers', icon: 'fa-heading', describe: (k) => 'Headers from row ' + ((+k.row || 0) + 1) + (k.row ? ' (skip ' + k.row + ' row' + (k.row > 1 ? 's' : '') + ' above)' : '') },
    DemoteHeaders: { label: 'Demoted Headers', icon: 'fa-arrow-down-short-wide', describe: () => 'Use headers as first row' },
    FillDown: { label: 'Filled Down', icon: 'fa-angles-down', describe: (k) => short(k.cols) },
    FillUp: { label: 'Filled Up', icon: 'fa-angles-up', describe: (k) => short(k.cols) },
    ReplaceValues: { label: 'Replaced Value', icon: 'fa-right-left', describe: (k) => '"' + (k.find === null || k.find === '' ? 'null' : k.find) + '" → "' + (k.replace === null || k.replace === '' ? 'null' : k.replace) + '" in ' + short(k.cols, 2) },
    ReplaceErrors: { label: 'Replaced Errors', icon: 'fa-bandage', describe: (k) => 'with "' + (k.value || 'null') + '" in ' + short(k.cols, 2) },
    RemoveErrors: { label: 'Removed Errors', icon: 'fa-circle-xmark', describe: (k) => (k.cols && k.cols.length ? short(k.cols) : 'any column') },
    KeepErrors: { label: 'Kept Errors', icon: 'fa-triangle-exclamation', describe: (k) => (k.cols && k.cols.length ? short(k.cols) : 'any column') },
    TextTransform: { label: 'Transformed Text', icon: 'fa-font', describe: (k) => ({ upper: 'UPPERCASE', lower: 'lowercase', trim: 'Trim', clean: 'Clean', proper: 'Capitalize Each Word' }[k.op]) + ' ' + short(k.cols, 2) },
    RoundNumbers: { label: 'Rounded', icon: 'fa-hashtag', describe: (k) => short(k.cols, 2) + ' to ' + k.digits + ' digits' },
    SplitColumn: { label: 'Split Column', icon: 'fa-scissors', describe: (k) => '`' + k.col + '` ' + (k.mode === 'positions' ? 'at positions ' + k.positions : k.mode === 'rows' ? 'into rows by "' + k.delimiter + '"' : 'by "' + k.delimiter + '"' + (k.mode === 'first' ? ' (first)' : k.mode === 'last' ? ' (last)' : '')) },
    MergeColumns: { label: 'Merged Columns', icon: 'fa-object-group', describe: (k) => short(k.cols) + ' → `' + k.name + '`' },
    AddColumn: { label: 'Added Custom', icon: 'fa-square-plus', describe: (k) => '`' + k.name + '` = ' + k.formula },
    ConditionalColumn: { label: 'Added Conditional Column', icon: 'fa-code-branch', describe: (k) => '`' + k.name + '` (' + (k.rules || []).length + ' rule' + ((k.rules || []).length === 1 ? '' : 's') + ')' },
    IndexColumn: { label: 'Added Index', icon: 'fa-list-ol', describe: (k) => '`' + k.name + '` from ' + k.start + ' step ' + k.step },
    DuplicateColumn: { label: 'Duplicated Column', icon: 'fa-clone', describe: (k) => '`' + k.col + '`' },
    GroupBy: { label: 'Grouped Rows', icon: 'fa-layer-group', lazy: false, describe: (k) => 'by ' + (short(k.keys) || '(all rows)') + ' · ' + (k.aggs || []).length + ' aggregation' + ((k.aggs || []).length === 1 ? '' : 's') },
    Unpivot: { label: 'Unpivoted Columns', icon: 'fa-table-cells', describe: (k) => (k.ids && k.ids.length ? 'keep ' + short(k.ids) : 'unpivot ' + short(k.values)) },
    Pivot: { label: 'Pivoted Column', icon: 'fa-table-cells-large', lazy: false, materializes: true, describe: (k) => '`' + k.on + '` → columns, values `' + (k.values || '(count)') + '` (' + (k.agg || 'sum') + ')' },
    Transpose: { label: 'Transposed Table', icon: 'fa-rotate', lazy: false, materializes: true, describe: (k) => (k.headerCol ? 'headers from `' + k.headerCol + '`' : 'rows ↔ columns') },
    Merge: { label: 'Merged Queries', icon: 'fa-code-merge', lazy: false, describe: (k) => (k.how || 'left') + ' join ' + (PQ.queryName ? PQ.queryName(k.right) : '') + ' on ' + (k.on || []).map((p) => p[0] === p[1] ? p[0] : p[0] + '=' + p[1]).join(', ') },
    Append: { label: 'Appended Queries', icon: 'fa-layer-group', describe: (k) => (k.others || []).map((o) => (PQ.queryName ? PQ.queryName(o) : o)).join(', ') + ' (' + (k.mode || 'diagonal') + ')' },
    Window: { label: 'Added Window Column', icon: 'fa-chart-line', describe: (k) => '`' + k.name + '` = ' + k.op + (k.col ? '(' + k.col + ')' : '') + (k.partition && k.partition.length ? ' over ' + short(k.partition, 2) : '') },
    ExpandJson: { label: 'Expanded JSON', icon: 'fa-sitemap', describe: (k) => '`' + k.col + '`' },
    CustomSql: { label: 'Custom SQL', icon: 'fa-terminal', lazy: false, describe: (k) => (k.sql || '').replace(/\s+/g, ' ').slice(0, 60) },
    Checkpoint: { label: 'Checkpoint', icon: 'fa-floppy-disk', lazy: false, materializes: true, describe: () => 'Buffer result (Table.Buffer)' },
  };

  S.label = (type) => (S.CATALOG[type] || { label: type }).label;
  S.describe = function (kind) { try { return (S.CATALOG[kind.type] || { describe: () => '' }).describe(kind); } catch (e) { return ''; } };
  S.icon = (type) => (S.CATALOG[type] || {}).icon || 'fa-gear';

  /** Replace a column name everywhere a step references it (used by the "Use X instead" fix). */
  const NON_COLUMN_KEYS = new Set(['find', 'replace', 'value', 'name', 'sql', 'type', 'mode', 'op', 'agg', 'how', 'delimiter', 'sep', 'prefix', 'var', 'val', 'right', 'others', 'onError', 'locale', 'digits', 'positions', 'join']);
  const FORMULA_KEYS = new Set(['formula', 'when', 'then', 'else']);
  S.renameColumnInKind = function (kind, from, to) {
    const re = new RegExp('\\[' + String(from).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\]/g, ']]') + '\\]', 'g');
    const q = PQ.Formula.quoteCol(to);
    const walk = (v, key) => {
      if (typeof v === 'string') { if (FORMULA_KEYS.has(key)) return v.replace(re, q); if (!NON_COLUMN_KEYS.has(key) && v === from) return to; return v; }
      if (Array.isArray(v)) return v.map((x) => walk(x, key));
      if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = NON_COLUMN_KEYS.has(k) && k !== 'type' ? v[k] : walk(v[k], k); return o; }
      return v;
    };
    const out = walk(kind, '');
    if (kind.type === 'Rename') out.map = (kind.map || []).map((p) => [p[0] === from ? to : p[0], p[1]]);
    return out;
  };

  /* ================================ Python (Polars) code generation ================================ */
  const py = PQ.pyStr;
  const pyList = (a) => '[' + (a || []).map(py).join(', ') + ']';
  const pyVal = (v) => (v === null || v === undefined || v === '' ? 'None' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'True' : 'False') : !isNaN(+v) && String(v).trim() !== '' ? String(+v) : py(v));
  S.py = { py, pyList, pyVal };
  const formula = (src) => { try { return PQ.Formula.toPython(src); } catch (e) { return 'pl.lit(None)  # formula error: ' + e.message; } };

  const castExpr = (c, loc) => {
    const col = `pl.col(${py(c.col)})`;
    const L = PQ.LOCALES[loc] || PQ.LOCALES['en-US'];
    const strict = 'strict=False';
    switch (c.type) {
      case 'int': case 'number': {
        const clean = L.dec === ',' ? `.str.replace_all(r"[.\\s€$£]", "").str.replace(",", ".")` : `.str.replace_all(r"[,\\s€$£]", "")`;
        return `${col}.cast(pl.String)${clean}.cast(${PQ.POLARS_TYPES[c.type]}, ${strict})`;
      }
      case 'date': return `${col}.cast(pl.String).str.to_date(${L.dmy ? '"%d.%m.%Y", ' : ''}${strict})`;
      case 'datetime': return `${col}.cast(pl.String).str.to_datetime(${strict})`;
      case 'bool': return `${col}.cast(pl.String).str.to_lowercase().is_in(["true", "yes", "y", "1"])`;
      case 'text': return `${col}.cast(pl.String)`;
    }
    return col;
  };

  function sourceCode(src, vars, helpers, project) {
    if (!src) return 'pl.LazyFrame()';
    if (src.kind === 'query') return vars[src.query] || 'None  # missing query';
    if (src.kind === 'blank') return `pl.LazyFrame({${(src.columns || []).map((c, i) => py(c) + ': ' + pyList((src.rows || []).map((r) => r[i]))).join(', ')}})`;
    const pathOf = (name) => 'DATA_DIR / ' + py(name);
    if (src.kind === 'folder') {
      helpers.add('from pathlib import Path');
      const reader = src.format === 'excel' ? 'pl.read_excel(f, engine="calamine").lazy()' : `pl.scan_csv(f, separator=${py((src.csv && src.csv.delimiter) || ',')}, infer_schema=False)`;
      return `pl.concat(\n        [${reader}.with_columns(pl.lit(f.name).alias(${py(src.fileColumn || 'Source.Name')})) for f in sorted((DATA_DIR / ${py(src.folder)}).glob(${py(src.pattern || '*')}))],\n        how="diagonal_relaxed",\n    )`;
    }
    const kind = src.format || (PQ.IO ? PQ.IO.fileKind(src.fileName) : 'csv');
    if (kind === 'excel') {
      const it = src.item || {};
      if (it.type === 'table') return `pl.read_excel(${pathOf(src.fileName)}, table_name=${py(it.name)}, engine="calamine").lazy()`;
      if (it.type === 'sheets') {
        helpers.add('import fastexcel');
        return `pl.concat(\n        [pl.read_excel(${pathOf(src.fileName)}, sheet_name=s, engine="calamine").lazy().with_columns(pl.lit(s).alias(${py(it.sheetColumn || '_sheet')}))\n         for s in fastexcel.read_excel(${pathOf(src.fileName)}).sheet_names if fnmatch.fnmatch(s, ${py(it.pattern || '*')})],\n        how="diagonal_relaxed",\n    )`;
      }
      const sheet = it.sheet || it.name;
      const opts = ['"header_row": None'];
      if (it.type === 'range' && it.range) {
        const r = PQ.parseA1(it.range);
        if (r) {
          if (r.r1) opts.push(`"skip_rows": ${r.r1}`);
          if (r.r2 !== Infinity) opts.push(`"n_rows": ${r.r2 - r.r1 + 1}`);
          opts.push(`"use_columns": ${py(PQ.idxToCol(r.c1) + ':' + (r.c2 === Infinity ? 'XFD' : PQ.idxToCol(r.c2)))}`);
        }
      }
      return `pl.read_excel(${pathOf(src.fileName)}, sheet_name=${py(sheet)}, engine="calamine", read_options={${opts.join(', ')}}).lazy()`;
    }
    if (kind === 'parquet') return `pl.scan_parquet(${pathOf(src.fileName)})` + (src.columns && src.columns.length ? `.select(${pyList(src.columns)})` : '');
    if (kind === 'arrow') return `pl.scan_ipc(${pathOf(src.fileName)})`;
    if (kind === 'json') return /ndjson|jsonl/i.test(src.fileName) ? `pl.scan_ndjson(${pathOf(src.fileName)})` : `pl.read_json(${pathOf(src.fileName)}).lazy()`;
    const c = src.csv || {};
    const args = [pathOf(src.fileName)];
    if (c.delimiter && c.delimiter !== ',') args.push(`separator=${py(c.delimiter)}`);
    if (c.header === false) args.push('has_header=False');
    if (c.skipRows) args.push(`skip_rows=${c.skipRows}`);
    if (c.encoding && !/utf-8/.test(c.encoding)) args.push('encoding="utf8-lossy"');
    args.push('infer_schema=False');
    return `pl.scan_csv(${args.join(', ')})`;
  }

  function stepCode(k, ctx) {
    const { vars, helpers, loc } = ctx;
    switch (k.type) {
      case 'SelectColumns': case 'RemoveOtherColumns': return `.select(${pyList(k.cols)})`;
      case 'ReorderColumns': return `.select(pl.col(${pyList(k.cols)}), pl.exclude(${pyList(k.cols)}))`;
      case 'RemoveColumns': return `.drop(${pyList(k.cols)})`;
      case 'Rename': return `.rename({${(k.map || []).map((p) => py(p[0]) + ': ' + py(p[1])).join(', ')}})`;
      case 'ChangeType': {
        const exprs = (k.changes || []).map((c) => castExpr(c, c.locale || k.locale || loc).replace(/strict=False/g, k.onError === 'fail' ? 'strict=True' : 'strict=False'));
        return `.with_columns(\n        ${exprs.join(',\n        ')},\n    )`;
      }
      case 'Filter': return `.filter(${formula(PQ.Engine ? PQ.Engine.filterFormula(k) : k.formula)})`;
      case 'Sort': return `.sort(${pyList((k.by || []).map((b) => b.col))}, descending=[${(k.by || []).map((b) => (b.desc ? 'True' : 'False')).join(', ')}], nulls_last=True, maintain_order=True)`;
      case 'Distinct': return `.unique(${k.subset && k.subset.length ? 'subset=' + pyList(k.subset) + ', ' : ''}keep="first", maintain_order=True)`;
      case 'KeepDuplicates': return `.filter(pl.struct(${k.subset && k.subset.length ? pyList(k.subset) : 'pl.all()'}).is_duplicated())`;
      case 'KeepRows': switch (k.mode) {
        case 'top': return `.head(${k.n})`;
        case 'bottom': return `.tail(${k.n})`;
        case 'range': return `.slice(${k.offset || 0}, ${k.n})`;
        case 'remove_top': return `.slice(${k.n})`;
        case 'remove_bottom': return `.with_row_index("__i").filter(pl.col("__i") < pl.len() - ${k.n}).drop("__i")`;
        case 'alternate': return `.with_row_index("__i").filter(((pl.col("__i") - ${k.offset || 0}) % ${(+k.keep || 1) + (+k.skip || 1)}) < ${k.keep || 1}).drop("__i")`;
        case 'remove_blank': return `.filter(~pl.all_horizontal(pl.all().is_null()))`;
      } return '';
      case 'PromoteHeaders': helpers.add('def promote_headers'); return `.pipe(promote_headers, row=${k.row || 0})`;
      case 'DemoteHeaders': helpers.add('def demote_headers'); return `.pipe(demote_headers)`;
      case 'FillDown': return `.with_columns(pl.col(${pyList(k.cols)}).forward_fill())`;
      case 'FillUp': return `.with_columns(pl.col(${pyList(k.cols)}).backward_fill())`;
      case 'ReplaceValues': {
        const isNull = k.find === null || k.find === '' || k.find === undefined;
        if (isNull) return `.with_columns(pl.col(${pyList(k.cols)}).fill_null(${pyVal(k.replace)}))`;
        if (k.wholeCell === false) return `.with_columns(pl.col(${pyList(k.cols)}).str.replace_all(${py(k.find)}, ${py(k.replace || '')}, literal=True))`;
        return `.with_columns(pl.col(${pyList(k.cols)}).replace(${pyVal(k.find)}, ${pyVal(k.replace)}))`;
      }
      case 'ReplaceErrors': return `  # ReplaceErrors: Polars casts non-strictly, so errors are already null\n    .with_columns(pl.col(${pyList(k.cols)}).fill_null(${pyVal(k.value)}))`;
      case 'RemoveErrors': case 'KeepErrors': return `  # ${k.type}: per-cell errors are a Floe concept; nulls from failed casts are the Polars equivalent`;
      case 'TextTransform': return `.with_columns(pl.col(${pyList(k.cols)}).cast(pl.String)${{ upper: '.str.to_uppercase()', lower: '.str.to_lowercase()', trim: '.str.strip_chars()', clean: '.str.replace_all(r"\\s+", " ").str.strip_chars()', proper: '.str.to_titlecase()' }[k.op]})`;
      case 'RoundNumbers': return `.with_columns(pl.col(${pyList(k.cols)}).round(${k.digits || 0}))`;
      case 'SplitColumn': {
        if (k.mode === 'rows') return `.with_columns(pl.col(${py(k.col)}).str.split(${py(k.delimiter || ',')})).explode(${py(k.col)})${k.trim !== false ? `.with_columns(pl.col(${py(k.col)}).str.strip_chars())` : ''}`;
        const n = +k.count || 2;
        return `.with_columns(pl.col(${py(k.col)}).str.splitn(${py(k.delimiter || ',')}, ${n}).struct.rename_fields([${Array.from({ length: n }, (_, i) => py(k.col + '.' + (i + 1))).join(', ')}])).unnest(${py(k.col)})`;
      }
      case 'MergeColumns': return `.with_columns(pl.concat_str([${(k.cols || []).map((c) => `pl.col(${py(c)}).cast(pl.String).fill_null("")`).join(', ')}], separator=${py(k.sep === undefined ? ' ' : k.sep)}).alias(${py(k.name || 'Merged')})).drop(${pyList(k.cols)})`;
      case 'AddColumn': return `.with_columns((${formula(k.formula)}).alias(${py(k.name)}))`;
      case 'ConditionalColumn': return `.with_columns((${formula(PQ.Engine ? PQ.Engine.conditionalToFormula(k) : 'null')}).alias(${py(k.name)}))`;
      case 'IndexColumn': return (+k.step || 1) === 1 ? `.with_row_index(${py(k.name || 'Index')}, offset=${k.start || 0})` : `.with_columns((pl.int_range(pl.len()) * ${k.step} + ${k.start || 0}).alias(${py(k.name || 'Index')}))`;
      case 'DuplicateColumn': return `.with_columns(pl.col(${py(k.col)}).alias(${py(k.name || k.col + ' - Copy')}))`;
      case 'GroupBy': {
        const map = { count_rows: () => 'pl.len()', count: (c) => `pl.col(${c}).count()`, count_distinct: (c) => `pl.col(${c}).n_unique()`, sum: (c) => `pl.col(${c}).sum()`, mean: (c) => `pl.col(${c}).mean()`, median: (c) => `pl.col(${c}).median()`, min: (c) => `pl.col(${c}).min()`, max: (c) => `pl.col(${c}).max()`, first: (c) => `pl.col(${c}).first()`, last: (c) => `pl.col(${c}).last()`, concat: (c, a) => `pl.col(${c}).cast(pl.String).str.join(${py(a.sep === undefined ? ', ' : a.sep)})` };
        const aggs = (k.aggs || []).map((a) => `${map[a.fn](py(a.col), a)}.alias(${py(a.name || (PQ.Engine ? PQ.Engine.AGG[a.fn].label : a.fn) + (a.col ? ' of ' + a.col : ''))})`);
        if (!k.keys || !k.keys.length) return `.select(${aggs.join(', ')})`;
        return `.group_by(${pyList(k.keys)}, maintain_order=True).agg(\n        ${aggs.join(',\n        ')},\n    )`;
      }
      case 'Unpivot': return `.unpivot(${k.values && k.values.length ? 'on=' + pyList(k.values) + ', ' : ''}index=${pyList(k.ids)}, variable_name=${py(k.var || 'Attribute')}, value_name=${py(k.val || 'Value')})`;
      case 'Pivot': return `\n    # Pivot needs all data to know its output columns → materialize, then continue lazily\n    .collect().pivot(on=${py(k.on)}, index=${pyList(k.index)}, values=${k.values ? py(k.values) : 'None'}, aggregate_function=${py({ sum: 'sum', mean: 'mean', count_rows: 'len', min: 'min', max: 'max', first: 'first', last: 'last', median: 'median' }[k.agg || 'sum'] || 'first')}).lazy()`;
      case 'Transpose': return `\n    # Transpose forces materialization\n    .collect().transpose(include_header=True${k.headerCol ? ', column_names=' + py(k.headerCol) : ''}).lazy()`;
      case 'Merge': {
        const right = vars[k.right] || 'None';
        const how = { left: 'left', right: 'right', inner: 'inner', full: 'full', semi: 'semi', anti: 'anti', cross: 'cross' }[k.how || 'left'];
        const exp = k.expand && k.expand.length ? `.select(${pyList([...new Set((k.on || []).map((p) => p[1]).concat(k.expand))])})` : '';
        if (how === 'cross') return `.join(${right}${exp}, how="cross")`;
        const lo = (k.on || []).map((p) => p[0]), ro = (k.on || []).map((p) => p[1]);
        return `.join(\n        ${right}${exp},\n        left_on=${pyList(lo)}, right_on=${pyList(ro)},\n        how=${py(how)}${how === 'full' ? ', coalesce=True' : ''}, suffix=${py(k.prefix ? '_' + k.prefix : '_right')},\n    )`;
      }
      case 'Append': return `\n    .pipe(lambda lf: pl.concat([lf, ${(k.others || []).map((o) => vars[o] || 'None').join(', ')}], how=${py(k.mode === 'strict' ? 'vertical' : 'diagonal_relaxed')}))`;
      case 'Window': {
        const over = k.partition && k.partition.length ? `.over(${pyList(k.partition)})` : '';
        const c = `pl.col(${py(k.col || '')})`;
        const e = { cumsum: `${c}.cum_sum()`, row_number: `pl.int_range(1, pl.len() + 1)`, rank: `${c}.rank("min", descending=True)`, lag: `${c}.shift(${k.n || 1})`, lead: `${c}.shift(-${k.n || 1})`, pct_of_total: `${c} / ${c}.sum()`, moving_avg: `${c}.rolling_mean(${k.n || 3}, min_samples=1)` }[k.op];
        return (k.orderBy ? `.sort(${py(k.orderBy)}${k.desc ? ', descending=True' : ''})` : '') + `.with_columns(${e}${over}.alias(${py(k.name || k.op)}))`;
      }
      case 'ExpandJson': return `.with_columns(pl.col(${py(k.col)}).str.json_decode()).unnest(${py(k.col)})`;
      case 'CustomSql': {
        const tables = ['"self": LF'].concat(ctx.sqlRefs.map((r) => py(r.alias) + ': ' + r.var));
        return `\n    .pipe(lambda LF: pl.SQLContext({${tables.join(', ')}}).execute(\n        ${py((k.sql || '').replace(/\s+/g, ' ').trim())}\n    ))`;
      }
      case 'Checkpoint': return `\n    .collect().lazy()  # checkpoint`;
    }
    if (S.EXT_CODE && S.EXT_CODE[k.type]) return S.EXT_CODE[k.type](k, ctx);
    return `  # (unsupported step ${k.type})`;
  }

  const HELPERS = S.HELPERS = {
    'def promote_headers': `def promote_headers(lf: pl.LazyFrame, row: int = 0) -> pl.LazyFrame:
    """Use row \`row\` as column names and drop everything above it (report-style sheets)."""
    df = lf.collect()
    names = [str(v) if v is not None else f"Column{i + 1}" for i, v in enumerate(df.row(row))]
    seen: dict[str, int] = {}
    for i, n in enumerate(names):
        if n in seen:
            seen[n] += 1
            names[i] = f"{n}_{seen[n]}"
        else:
            seen[n] = 0
    return df.slice(row + 1).pipe(lambda d: d.rename(dict(zip(d.columns, names)))).lazy()`,
    'def demote_headers': `def demote_headers(lf: pl.LazyFrame) -> pl.LazyFrame:
    df = lf.collect().cast(pl.String)
    header = pl.DataFrame([df.columns], schema=df.columns, orient="row")
    return pl.concat([header, df]).rename({c: f"Column{i + 1}" for i, c in enumerate(df.columns)}).lazy()`,
  };

  /** Topological order of queries (dependencies first). Throws with a readable cycle path. */
  S.topo = function (project) {
    const byId = new Map(project.queries.map((q) => [q.id, q]));
    const deps = (q) => {
      const out = new Set();
      q.steps.forEach((st) => {
        const k = st.kind;
        if (k.type === 'Source' && k.source && k.source.kind === 'query') out.add(k.source.query);
        if (k.type === 'Merge' && k.right) out.add(k.right);
        if (k.type === 'Append') (k.others || []).forEach((o) => out.add(o));
        if (k.type === 'CustomSql') { const l = (k.sql || '').toLowerCase(); project.queries.forEach((o) => { if (o.id !== q.id && l.includes(PQ.snake(o.name))) out.add(o.id); }); }
      });
      return [...out].filter((id) => byId.has(id));
    };
    const order = [], state = new Map();
    const visit = (id, path) => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) { const p = path.slice(path.indexOf(id)).concat(id).map((x) => byId.get(x).name); const e = new Error('Circular reference: ' + p.join(' → ')); e.cycle = p; throw e; }
      state.set(id, 1);
      deps(byId.get(id)).forEach((d) => visit(d, path.concat(id)));
      state.set(id, 2);
      order.push(id);
    };
    project.queries.forEach((q) => visit(q.id, []));
    return { order, deps };
  };

  /** Whole project → runnable Polars Python script. */
  S.toPython = function (project, onlyQueryId) {
    const { order, deps } = S.topo(project);
    const byId = new Map(project.queries.map((q) => [q.id, q]));
    let ids = order;
    if (onlyQueryId) { const need = new Set(); const add = (id) => { if (need.has(id)) return; need.add(id); deps(byId.get(id)).forEach(add); }; add(onlyQueryId); ids = order.filter((id) => need.has(id)); }
    const vars = {}, used = new Set(['pl', 'lf', 'params', 'data_dir']);
    ids.forEach((id) => { const v = PQ.uniqueName(PQ.snake(byId.get(id).name), used); used.add(v); vars[id] = v; });
    const helpers = new Set();
    const blocks = ids.map((id) => {
      const q = byId.get(id);
      const steps = q.steps.filter((s) => !s.disabled);
      const src = steps[0] && steps[0].kind.type === 'Source' ? sourceCode(steps[0].kind.source, vars, helpers, project) : 'pl.LazyFrame()';
      const sqlRefs = project.queries.filter((o) => ids.includes(o.id) && o.id !== id).map((o) => ({ alias: PQ.snake(o.name), var: vars[o.id] }));
      const body = steps.slice(1).map((s) => {
        const code = stepCode(s.kind, { vars, helpers, loc: project.settings.locale, sqlRefs });
        const comment = '    # ' + s.name + (s.note ? ' — ' + s.note.replace(/\n/g, ' ') : '');
        return comment + '\n    ' + code.replace(/^\s*\n\s*/, '').replace(/\n {4}(?=\.)/g, '\n    ');
      });
      return `# ── ${q.name} ${'─'.repeat(Math.max(3, 60 - q.name.length))}\n${vars[id]} = (\n    ${src}\n${body.join('\n')}\n)`;
    });
    const params = (project.params || []).map((p) => `    ${py(p.name)}: ${p.type === 'number' ? pyVal(p.value) : p.type === 'date' ? 'date.fromisoformat(' + py(p.value) + ')' : p.type === 'list' ? pyList(String(p.value || '').split(',').map((s) => s.trim()).filter(Boolean)) : py(p.value)},`);
    const outputs = ids.map((id) => byId.get(id)).filter((q) => q.load && q.load.target && q.load.target !== 'none').map((q) => {
      const v = vars[q.id], f = PQ.snake(q.name);
      if (q.load.target === 'xlsx') return `    ${v}.collect().write_excel(OUT_DIR / "${f}.xlsx", worksheet=${py(q.name.slice(0, 31))}, table_style="Table Style Medium 2", autofit=True, freeze_panes=(1, 0))`;
      if (q.load.target === 'parquet') return `    ${v}.sink_parquet(OUT_DIR / "${f}.parquet")`;
      if (q.load.target === 'arrow') return `    ${v}.sink_ipc(OUT_DIR / "${f}.arrow")`;
      return `    ${v}.sink_csv(OUT_DIR / "${f}.csv")`;
    });
    const imports = ['import polars as pl', 'from pathlib import Path'];
    if (helpers.has('import fastexcel')) imports.push('import fnmatch', 'import fastexcel');
    if ((project.params || []).some((p) => p.type === 'date')) imports.push('from datetime import date');
    const helperCode = [...helpers].filter((h) => HELPERS[h]).map((h) => HELPERS[h]);
    return [
      '"""',
      `${project.name} — generated by Floe ${PQ.VERSION || ''} from ${onlyQueryId ? 'query "' + byId.get(onlyQueryId).name + '"' : 'the whole project'}.`,
      'Every query is a LazyFrame; nothing runs until .collect() / .sink_*().',
      'Requires: polars>=1.20  (plus fastexcel for Excel sources)',
      '"""',
      imports.join('\n'),
      '',
      'DATA_DIR = Path(__file__).parent / "data"   # where the source files live',
      'OUT_DIR = Path(__file__).parent / "out"',
      '',
      'PARAMS = {', ...params, '}',
      '',
      ...(helperCode.length ? [helperCode.join('\n\n\n'), '', ''] : []),
      blocks.join('\n\n'),
      '',
      '',
      'if __name__ == "__main__":',
      '    OUT_DIR.mkdir(exist_ok=True)',
      ...(outputs.length ? outputs : [`    print(${vars[ids[ids.length - 1]] || 'None'}.collect())`]),
      '',
    ].join('\n');
  };

  /* ================================ Project file format ================================ */
  S.FORMAT_VERSION = 1;
  /** Git-friendly layout: project.json + queries/<name>.json, pretty-printed with stable key order. */
  S.toFiles = function (project) {
    const files = {};
    const qfile = (q) => 'queries/' + PQ.snake(q.name) + '.json';
    files['project.json'] = PQ.stableStringify({ format_version: S.FORMAT_VERSION, name: project.name, settings: project.settings, params: project.params || [], queries: project.queries.map((q) => ({ id: q.id, file: qfile(q) })) }, 2) + '\n';
    project.queries.forEach((q) => { files[qfile(q)] = PQ.stableStringify(q, 2) + '\n'; });
    return files;
  };
  /** Migrations run from day one: every future format change adds a step here. */
  S.migrate = function (p) {
    if (!p || typeof p !== 'object') throw new Error('Not a Floe project');
    if (!p.format_version) p.format_version = 1;
    if (p.format_version > S.FORMAT_VERSION) throw new Error('This project was saved by a newer Floe (format ' + p.format_version + ')');
    p.settings = Object.assign({ previewRows: 1000, locale: 'en-US' }, p.settings || {});
    p.params = p.params || [];
    (p.queries || []).forEach((q) => { q.load = q.load || { target: 'none' }; q.steps = q.steps || []; q.steps.forEach((s) => { s.id = s.id || PQ.uid('s'); }); });
    return p;
  };
})();
