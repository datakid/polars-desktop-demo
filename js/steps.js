(function () {
  const PQ = self.PQ;
  const S = (PQ.Steps = {});

  const cols = (a) => (a || []).map((c) => '`' + c + '`').join(', ');
  const short = (a, n) => { a = a || []; return a.length > (n || 3) ? cols(a.slice(0, n || 3)) + ' +' + (a.length - (n || 3)) : cols(a); };

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
        if (c.type === 'int') return `(floe_parse_number(${col}${L.dec === ',' ? ', True' : ''}) + 0.5).floor().cast(pl.Int64, ${strict})`;
        return `floe_parse_number(${col}${L.dec === ',' ? ', True' : ''})`;
      }
      case 'date': return `floe_parse_datetime(${col}${L.dmy ? ', True' : ''}).dt.date()`;
      case 'datetime': return `floe_parse_datetime(${col}${L.dmy ? ', True' : ''})`;
      case 'bool': { const t = `${col}.cast(pl.String).str.strip_chars().str.to_lowercase()`; return `pl.when(${t}.is_in(["true", "yes", "y", "1", "wahr", "vrai"])).then(True).when(${t}.is_in(["false", "no", "n", "0", "falsch", "faux"])).then(False)`; }
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
      helpers.add('def floe_scan_csv');
      const reader = src.format === 'excel' ? 'pl.read_excel(f, engine="calamine").lazy()' : `floe_scan_csv(f, ${py((src.csv && src.csv.delimiter) || ',')})`;
      return `pl.concat(\n        [${reader}.select(pl.lit(f.name).alias(${py(src.fileColumn || 'Source.Name')}), pl.all()) for f in sorted((DATA_DIR / ${py(src.folder)}).glob(${py(src.pattern || '*')}))],\n        how="diagonal_relaxed",\n    )`;
    }
    const kind = src.format || (PQ.IO ? PQ.IO.fileKind(src.fileName) : 'csv');
    if (kind === 'excel') {
      const it = src.item || {};
      if (it.type === 'table') return `pl.read_excel(${pathOf(src.fileName)}, table_name=${py(it.name)}, engine="calamine").lazy()`;
      if (it.type === 'sheets') {
        helpers.add('import fastexcel');
        return `pl.concat(\n        [pl.read_excel(${pathOf(src.fileName)}, sheet_name=s, engine="calamine").lazy().select(pl.lit(s).alias(${py(it.sheetColumn || '_sheet')}), pl.all())\n         for s in fastexcel.read_excel(${pathOf(src.fileName)}).sheet_names if fnmatch.fnmatch(s, ${py(it.pattern || '*')})],\n        how="diagonal_relaxed",\n    )`;
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
      helpers.add('def floe_excel_raw');
      return `pl.read_excel(${pathOf(src.fileName)}, sheet_name=${py(sheet)}, engine="calamine", read_options={${opts.join(', ')}}).lazy().pipe(floe_excel_raw)`;
    }
    if (kind === 'parquet') return `pl.scan_parquet(${pathOf(src.fileName)})` + (src.columns && src.columns.length ? `.select(${pyList(src.columns)})` : '');
    if (kind === 'arrow') return `pl.scan_ipc(${pathOf(src.fileName)})`;
    if (kind === 'json') return /ndjson|jsonl/i.test(src.fileName) ? `pl.scan_ndjson(${pathOf(src.fileName)})` : `pl.read_json(${pathOf(src.fileName)}).lazy()`;
    const c = src.csv || {};
    const args = [pathOf(src.fileName)];
    if (c.delimiter && c.delimiter !== ',') args.push(`separator=${py(c.delimiter)}`);
    if (c.header === false) args.push('has_header=False');
    if (c.skipRows) args.push(`skip_rows=${c.skipRows}`);
    if (c.encoding && !/^utf-?8$/i.test(c.encoding)) args.push(`encoding=${py(c.encoding)}`);
    helpers.add('def floe_scan_csv');
    return `floe_scan_csv(${args.join(', ')})`;
  }

  function stepCode(k, ctx) {
    const { vars, helpers, loc } = ctx;
    switch (k.type) {
      case 'SelectColumns': case 'RemoveOtherColumns': return `.select(${pyList(k.cols)})`;
      case 'ReorderColumns': return `.select(pl.col(${pyList(k.cols)}), pl.exclude(${pyList(k.cols)}))`;
      case 'RemoveColumns': return `.drop(${pyList(k.cols)})`;
      case 'Rename': return `.rename({${(k.map || []).map((p) => py(p[0]) + ': ' + py(p[1])).join(', ')}})`;
      case 'ChangeType': {
        const textCols = (k.changes || []).filter((c) => c.type === 'text').map((c) => c.col);
        if ((k.changes || []).some((c) => c.type === 'date' || c.type === 'datetime')) helpers.add('def floe_parse_datetime');
        if ((k.changes || []).some((c) => c.type === 'int' || c.type === 'number')) helpers.add('def floe_parse_number');
        if (textCols.length) { helpers.add('def floe_as_text'); helpers.add('def floe_datetime_text'); }
        const exprs = (k.changes || []).map((c) => castExpr(c, c.locale || k.locale || loc).replace(/strict=False/g, k.onError === 'fail' ? 'strict=True' : 'strict=False') + `.alias(${py(c.col)})`);
        const checked = (k.changes || []).filter((c) => ['int', 'number', 'date', 'datetime', 'bool'].includes(c.type));
        const guard = k.onError === 'fail' && checked.length ? (helpers.add('def floe_assert_cast'), `.pipe(floe_assert_cast, {${checked.map((c) => py(c.col) + ': ' + castExpr(c, c.locale || k.locale || loc)).join(', ')}})\n    `) : '';
        return `${guard}${textCols.length ? '.pipe(floe_datetime_text, ' + pyList(textCols) + ')\n    ' : ''}.with_columns(\n        ${exprs.join(',\n        ')},\n    )`;
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
        case 'alternate': { const off = Math.max(0, +k.offset || 0), keep = Math.max(1, +k.keep || 1), skip = Math.max(0, +k.skip || 1); return `.with_row_index("__i").filter((pl.col("__i") >= ${off}) & (((pl.col("__i") - ${off}) % ${keep + skip}) < ${keep})).drop("__i")`; }
        case 'remove_blank': return `.filter(~pl.all_horizontal(pl.all().is_null()))`;
      } return '';
      case 'PromoteHeaders': helpers.add('def promote_headers'); return `.pipe(promote_headers, row=${k.row || 0})`;
      case 'DemoteHeaders': helpers.add('def floe_as_text'); helpers.add('def demote_headers'); return `.pipe(demote_headers)`;
      case 'FillDown': return `.with_columns(pl.col(${pyList(k.cols)}).forward_fill())`;
      case 'FillUp': return `.with_columns(pl.col(${pyList(k.cols)}).backward_fill())`;
      case 'ReplaceValues': {
        const isNull = k.find === null || k.find === '' || k.find === undefined;
        if (isNull) return `.with_columns(pl.col(${pyList(k.cols)}).fill_null(${pyVal(k.replace)}))`;
        if (k.wholeCell === false) return `.with_columns(pl.col(${pyList(k.cols)}).str.replace_all(${py(k.find)}, ${py(k.replace || '')}, literal=True))`;
        return `.with_columns(pl.col(${pyList(k.cols)}).replace(${pyVal(k.find)}, ${pyVal(k.replace)}))`;
      }
      case 'ReplaceErrors': return k.value === undefined || k.value === null || k.value === '' ? `  # ReplaceErrors with null: Polars casts non-strictly, so errors are already null` : `  # ReplaceErrors: Polars casts non-strictly, so errors are already null\n    .with_columns(pl.col(${pyList(k.cols)}).fill_null(${pyVal(k.value)}))`;
      case 'RemoveErrors': case 'KeepErrors': return `  # ${k.type}: per-cell errors are a Floe concept; nulls from failed casts are the Polars equivalent`;
      case 'TextTransform':
        if (k.op === 'proper') { helpers.add('def floe_proper'); return `.with_columns(floe_proper(pl.col(${pyList(k.cols)})))`; }
        return `.with_columns(pl.col(${pyList(k.cols)}).cast(pl.String)${{ upper: '.str.to_uppercase()', lower: '.str.to_lowercase()', trim: '.str.strip_chars()', clean: '.str.replace_all(r"\\s+", " ").str.strip_chars()' }[k.op]})`;
      case 'RoundNumbers': {
        const d = Math.max(0, Math.min(12, +k.digits || 0)), f = Math.pow(10, d), base = `pl.col(${pyList(k.cols)}).cast(pl.Float64)`;
        return d === 0 ? `.with_columns((${base} + 0.5).floor().cast(pl.Int64))` : `.with_columns((${base} * ${f} + 0.5).floor() / ${f})`;
      }
      case 'SplitColumn': {
        const delimiter = py(k.delimiter === undefined || k.delimiter === '' ? ',' : k.delimiter);
        const trim = k.trim !== false ? 'True' : 'False';
        helpers.add('def floe_as_text');
        if (k.mode === 'rows') { helpers.add('def floe_split_rows'); return `.pipe(floe_split_rows, ${py(k.col)}, ${delimiter}, ${trim})`; }
        helpers.add('def floe_split_columns');
        const mode = k.mode === 'first' || k.mode === 'last' || k.mode === 'positions' ? k.mode : 'each';
        const positions = String(k.positions || '').split(',').map((x) => parseInt(x.trim(), 10)).filter((x) => !isNaN(x));
        return `.pipe(floe_split_columns, ${py(k.col)}, ${py(mode)}, ${delimiter}, ${Math.ceil(Math.max(0, +k.count || 0))}, ${trim}, [${positions.join(', ')}])`;
      }
      case 'MergeColumns': helpers.add('def floe_as_text'); helpers.add('def floe_merge_columns'); return `.pipe(floe_merge_columns, ${pyList(k.cols)}, ${py(k.sep === undefined ? ' ' : k.sep)}, ${py(k.name || 'Merged')})`;
      case 'AddColumn': return `.with_columns((${formula(k.formula)}).alias(${py(k.name)}))`;
      case 'ConditionalColumn': return `.with_columns((${formula(PQ.Engine ? PQ.Engine.conditionalToFormula(k) : 'null')}).alias(${py(k.name)}))`;
      case 'IndexColumn': return (+k.step || 1) === 1 ? `.with_row_index(${py(k.name || 'Index')}, offset=${k.start || 0})` : `.with_columns((pl.int_range(pl.len()) * ${k.step} + ${k.start || 0}).alias(${py(k.name || 'Index')}))`;
      case 'DuplicateColumn': helpers.add('def floe_duplicate_column'); return `.pipe(floe_duplicate_column, ${py(k.col)}, ${py(k.name || k.col + ' - Copy')})`;
      case 'GroupBy': {
        const map = { count_rows: () => 'pl.len()', count: (c) => `pl.col(${c}).count()`, count_distinct: (c) => `pl.col(${c}).drop_nulls().n_unique()`, sum: (c) => `pl.col(${c}).sum()`, mean: (c) => `pl.col(${c}).mean()`, median: (c) => `pl.col(${c}).median()`, std: (c) => `pl.col(${c}).std()`, mode: (c) => `pl.col(${c}).drop_nulls().mode().sort().first()`, percentile: (c, a) => `pl.col(${c}).quantile(${(a.p === undefined || a.p === '' ? 50 : +a.p) / 100}, "linear")`, var: (c) => `pl.col(${c}).var()`, min: (c) => `pl.col(${c}).min()`, max: (c) => `pl.col(${c}).max()`, first: (c) => `pl.col(${c}).first()`, last: (c) => `pl.col(${c}).last()`, concat: (c, a) => `pl.col(${c}).cast(pl.String).str.join(${py(a.sep === undefined ? ', ' : a.sep)})` };
        const aggs = (k.aggs || []).map((a) => `${map[a.fn](py(a.col), a)}.alias(${py(a.name || (PQ.Engine ? PQ.Engine.aggName(a) : a.fn + (a.col ? ' of ' + a.col : '')))})`);
        if (!k.keys || !k.keys.length) return `.select(${aggs.join(', ')})`;
        return `.group_by(${pyList(k.keys)}, maintain_order=True).agg(\n        ${aggs.join(',\n        ')},\n    )`;
      }
      case 'Unpivot': helpers.add('def floe_as_text'); helpers.add('def floe_unpivot'); return `.pipe(floe_unpivot, ${k.ids ? pyList(k.ids) : 'None'}, ${k.values && k.values.length ? pyList(k.values) : 'None'}, ${py(k.var || 'Attribute')}, ${py(k.val || 'Value')}, ${k.dropNulls !== false ? 'True' : 'False'})`;
      case 'Pivot': return `\n    # Pivot needs all data to know its output columns → materialize, then continue lazily\n    .collect().pivot(on=${py(k.on)}, index=${pyList(k.index)}, values=${k.values ? py(k.values) : 'None'}, aggregate_function=${{ sum: 'pl.when(pl.element().len() > 0).then(pl.element().sum())', count_rows: 'pl.when(pl.element().len() > 0).then(pl.element().len())' }[k.agg || 'sum'] || py({ mean: 'mean', min: 'min', max: 'max', first: 'first', last: 'last', median: 'median' }[k.agg] || 'first')}).lazy()`;
      case 'Transpose': {
        if (!k.headerCol) return `\n    # Transpose forces materialization\n    .collect().pipe(lambda d: d.transpose(include_header=True, header_name="Name", column_names=[f"Column{i + 1}" for i in range(d.height)])).lazy()`;
        helpers.add('def floe_as_text');
        return `\n    # Transpose forces materialization\n    .collect().pipe(lambda d: d.with_columns(floe_as_text(pl.col(${py(k.headerCol)}), d.schema[${py(k.headerCol)}]).alias(${py(k.headerCol)}))).transpose(include_header=True, header_name="Name", column_names=${py(k.headerCol)}).lazy()`;
      }
      case 'Merge': {
        helpers.add('def floe_merge');
        const how = { left: 'left', right: 'right', inner: 'inner', full: 'full', semi: 'semi', anti: 'anti', cross: 'cross' }[k.how || 'left'];
        const lo = (k.on || []).map((p) => p[0]), ro = (k.on || []).map((p) => p[1]);
        return `.pipe(floe_merge, ${vars[k.right] || 'None'}, ${py(how)}, ${pyList(lo)}, ${pyList(ro)}, ${pyList(k.expand || [])}, ${py(k.prefix || '')}${k.castKeys ? ', True' : ''})`;
      }
      case 'Append': return `\n    .pipe(lambda lf: pl.concat([lf, ${(k.others || []).map((o) => vars[o] || 'None').join(', ')}], how=${py(k.mode === 'strict' ? 'vertical' : 'diagonal_relaxed')}))`;
      case 'Window': {
        const over = k.partition && k.partition.length ? `.over(${pyList(k.partition)})` : '';
        const c = `pl.col(${py(k.col || '')})`;
        const e = { cumsum: `${c}.cum_sum()`, row_number: `pl.int_range(1, pl.len() + 1)`, rank: `${c}.rank("min", descending=True)`, dense_rank: `${c}.rank("dense", descending=True)`, diff: `${c}.diff()`, cummax: `${c}.cum_max()`, cummin: `${c}.cum_min()`, pct_change: `pl.when(${c}.shift(1) != 0).then((${c} - ${c}.shift(1)) / ${c}.shift(1))`, rolling_sum: `${c}.rolling_sum(${k.n || 3}, min_samples=1)`, rolling_min: `${c}.rolling_min(${k.n || 3}, min_samples=1)`, rolling_max: `${c}.rolling_max(${k.n || 3}, min_samples=1)`, rolling_std: `${c}.rolling_std(${k.n || 3}, min_samples=2)`, lag: `${c}.shift(${k.n || 1})`, lead: `${c}.shift(-${k.n || 1})`, pct_of_total: `${c} / ${c}.sum()`, moving_avg: `${c}.rolling_mean(${k.n || 3}, min_samples=1)` }[k.op];
        return (k.orderBy ? `.sort(${py(k.orderBy)}${k.desc ? ', descending=True' : ''})` : '') + `.with_columns((${e})${over}.alias(${py(k.name || k.op)}))`;
      }
      case 'ExpandJson': helpers.add('def floe_expand_json'); return `.pipe(floe_expand_json, ${py(k.col)})`;
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
    names, used = [], set()
    for i, v in enumerate(df.row(row)):
        base = str(v).strip() if v is not None and str(v).strip() else f"Column{i + 1}"
        name, k = base, 1
        while name in used:
            name, k = f"{base}_{k}", k + 1
        used.add(name)
        names.append(name)
    return df.slice(row + 1).pipe(lambda d: d.rename(dict(zip(d.columns, names)))).lazy()`,
    'def floe_datetime_text': `def floe_datetime_text(lf: pl.LazyFrame, cols: list[str]) -> pl.LazyFrame:
    schema = lf.collect_schema()
    return lf.with_columns([floe_as_text(pl.col(c), pl.Datetime).alias(c) for c in cols if schema.get(c) is not None and schema[c] == pl.Datetime])`,
    'def floe_expand_json': `def floe_expand_json(lf: pl.LazyFrame, col: str) -> pl.LazyFrame:
    dtype = lf.select(pl.col(col)).collect().to_series().str.json_decode().dtype
    names = [f"{col}.{field.name}" for field in dtype.fields]
    return lf.with_columns(pl.col(col).str.json_decode(dtype).struct.rename_fields(names)).unnest(col)`,
    'def floe_proper': `def floe_proper(column: pl.Expr) -> pl.Expr:
    import unicodedata

    def fix(value):
        if value is None:
            return None
        out, inside = [], False
        for ch in value.lower():
            category = unicodedata.category(ch)
            letter = category.startswith("L")
            out.append(ch.upper() if letter and not inside else ch)
            inside = letter or category.startswith("N") or ch == "'"
        return "".join(out)

    return column.cast(pl.String).map_elements(fix, return_dtype=pl.String)`,
    'def floe_parse_datetime': `def floe_parse_datetime(column: pl.Expr, dmy: bool = False) -> pl.Expr:
    column = column if isinstance(column, pl.Expr) else pl.lit(column)
    months = {name: number + 1 for number, name in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split())}
    text = column.cast(pl.String).str.strip_chars()
    clock = r"(?:[ T](\\d{1,2}):(\\d{2})(?::(\\d{2}))?)?"
    none = pl.lit(None, pl.Int32)

    def number(group: pl.Expr, name: str) -> pl.Expr:
        return group.struct.field(name).cast(pl.Int32, strict=False)

    def month_of(group: pl.Expr, name: str) -> pl.Expr:
        return group.struct.field(name).str.to_lowercase().replace_strict(months, default=None, return_dtype=pl.Int32)

    iso = text.str.extract_groups(r"^(\\d{4})[-/.](\\d{1,2})[-/.](\\d{1,2})" + clock)
    local = text.str.extract_groups(r"^(\\d{1,2})[-/.](\\d{1,2})[-/.](\\d{2,4})" + clock + "$")
    named = text.str.extract_groups(r"^(\\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*[ -,]*(\\d{2,4})$")
    us = text.str.extract_groups(r"^([A-Za-z]{3})[A-Za-z]*\\.? (\\d{1,2}),? (\\d{4})$")
    first, second = number(local, "1"), number(local, "2")
    parts = [
        (number(iso, "1"), number(iso, "2"), number(iso, "3"), number(iso, "4"), number(iso, "5"), number(iso, "6")),
        (number(local, "3"), second if dmy else first, first if dmy else second, number(local, "4"), number(local, "5"), number(local, "6")),
        (number(named, "3"), month_of(named, "2"), number(named, "1"), none, none, none),
        (number(us, "3"), month_of(us, "1"), number(us, "2"), none, none, none),
    ]
    built = []
    for year, month, day, hour, minute, second in parts:
        year = pl.when(year < 100).then(pl.when(year < 50).then(year + 2000).otherwise(year + 1900)).otherwise(year)
        hour, minute, second = hour.fill_null(0), minute.fill_null(0), second.fill_null(0)
        valid = year.is_not_null() & month.is_between(1, 12) & day.is_between(1, 31)
        safe_year, safe_month = pl.when(valid).then(year).otherwise(2000), pl.when(valid).then(month).otherwise(1)
        valid = valid & (day <= pl.date(safe_year, safe_month, 1).dt.month_end().dt.day())
        stamp = pl.datetime(safe_year, safe_month, pl.when(valid).then(day).otherwise(1)) + pl.duration(hours=pl.when(valid).then(hour).otherwise(0), minutes=pl.when(valid).then(minute).otherwise(0), seconds=pl.when(valid).then(second).otherwise(0))
        built.append(pl.when(valid & (stamp.dt.day() == day)).then(stamp))
    serial = text.str.extract(r"^(\\d+(?:\\.\\d+)?)$", 1).cast(pl.Float64, strict=False)
    whole = serial.floor()
    seconds = ((serial - whole) * 86400 + 0.5).floor()
    base = pl.when(serial < 60).then(pl.datetime(1899, 12, 31)).otherwise(pl.datetime(1899, 12, 30))
    built.append(pl.when(serial.is_not_null() & (serial > 0) & (serial < 2958466)).then(base + pl.duration(days=whole.fill_null(0).cast(pl.Int64), seconds=seconds.fill_null(0).cast(pl.Int64))))
    return pl.coalesce(built)`,
    'def floe_parse_number': `def floe_parse_number(column: pl.Expr, comma: bool = False) -> pl.Expr:
    column = column if isinstance(column, pl.Expr) else pl.lit(column)
    text = column.cast(pl.String).str.strip_chars()
    negative = text.str.contains(r"^\\(.*\\)$")
    unwrapped = text.str.replace(r"^\\((.*)\\)$", "\${1}")
    percent = unwrapped.str.ends_with("%")
    inner = unwrapped.str.strip_suffix("%").str.replace_all(r"[$€£¥\\s\\u00a0]", "")
    inner = inner.str.replace_all(r"\\.", "").str.replace(",", ".") if comma else inner.str.replace_all(",", "")
    value = pl.when(inner.str.contains(r"^[-+]?(\\d+\\.?\\d*|\\.\\d+)([eE][-+]?\\d+)?$")).then(inner.cast(pl.Float64, strict=False))
    value = pl.when(negative).then(-value).otherwise(value)
    return pl.when(percent).then(value / 100).otherwise(value)`,
    'def floe_assert_cast': `def floe_assert_cast(lf: pl.LazyFrame, casts: dict) -> pl.LazyFrame:
    for name, cast in casts.items():
        source = pl.col(name).cast(pl.String).str.strip_chars()
        bad = lf.filter(source.is_not_null() & (source != "") & cast.is_null()).select(pl.len()).collect().item()
        if bad:
            raise ValueError(f"{bad} value(s) in column {name} could not be converted")
    return lf`,
    'def floe_merge': `def floe_merge(lf: pl.LazyFrame, right: pl.LazyFrame, how: str, left_on: list[str], right_on: list[str], expand: list[str], prefix: str, cast_keys: bool = False) -> pl.LazyFrame:
    existing = set(lf.collect_schema().names())
    cols = expand or [name for name in right.collect_schema().names() if name not in set(right_on)]
    names = {}
    for col in cols:
        base = f"{prefix}.{col}" if prefix else col
        name, i = base, 1
        while name in existing:
            name, i = f"{base}_{i}", i + 1
        existing.add(name)
        names[col] = name
    if how == "cross":
        return lf.join(right.select([pl.col(col).alias(names[col]) for col in cols]), how="cross")
    left_keys = [f"__left{i}" for i in range(len(left_on))]
    right_keys = [f"__right{i}" for i in range(len(right_on))]
    schema = lf.collect_schema()
    shape = (lambda column: column.cast(pl.String)) if cast_keys else (lambda column: column)
    left = lf.with_columns([shape(pl.col(key)).alias(alias) for key, alias in zip(left_on, left_keys)])
    keyed = right.select([shape(pl.col(key)).alias(alias) for key, alias in zip(right_on, right_keys)])
    if how in ("semi", "anti"):
        return left.join(keyed, left_on=left_keys, right_on=right_keys, how=how).drop(left_keys)
    side = right.select([shape(pl.col(key)).alias(alias) for key, alias in zip(right_on, right_keys)] + [pl.col(col).alias(names[col]) for col in cols]).with_columns(pl.lit(True).alias("__present"))
    joined = left.join(side, left_on=left_keys, right_on=right_keys, how="left" if how == "left" else "inner" if how == "inner" else "full", coalesce=False, maintain_order="left_right")
    if how in ("right", "full"):
        joined = joined.with_columns([pl.coalesce(pl.col(key), pl.col(alias).cast(schema[key])).alias(key) for key, alias in zip(left_on, right_keys)])
    if how == "right":
        joined = joined.filter(pl.col("__present").is_not_null())
    return joined.drop(left_keys + right_keys + ["__present"])`,
    'def floe_scan_csv': `def floe_scan_csv(path: Path, separator: str = ",", has_header: bool = True, skip_rows: int = 0, encoding: str = "utf-8") -> pl.LazyFrame:
    options = dict(separator=separator, has_header=False, skip_rows=skip_rows, infer_schema=False)
    if encoding.lower().replace("-", "").replace("_", "") in ("utf8", "utf8sig", "ascii"):
        raw = pl.scan_csv(path, **options)
    else:
        raw = pl.read_csv(path.read_bytes().decode(encoding, errors="replace").encode("utf-8"), **options).lazy()
    raw = raw.filter(~pl.all_horizontal(pl.all().is_null()))
    old_names = raw.collect_schema().names()
    first = raw.head(1).collect().rows() if has_header else []
    header = first[0] if first else [None] * len(old_names)
    names, used = [], set()
    for i, value in enumerate(header if has_header else [None] * len(old_names)):
        base = str(value).strip() if value is not None and str(value).strip() else f"Column{i + 1}"
        name, k = base, 1
        while name in used:
            name, k = f"{base}_{k}", k + 1
        used.add(name)
        names.append(name)
    return (raw.slice(1) if has_header else raw).rename(dict(zip(old_names, names)))`,
    'def floe_excel_raw': `def floe_excel_raw(lf: pl.LazyFrame) -> pl.LazyFrame:
    names = lf.collect_schema().names()
    return lf.rename({name: f"Column{i + 1}" for i, name in enumerate(names)}).with_columns(pl.col(pl.String).replace({"true": "TRUE", "false": "FALSE"}))`,
    'def demote_headers': `def demote_headers(lf: pl.LazyFrame) -> pl.LazyFrame:
    df = lf.collect()
    df = df.select([floe_as_text(pl.col(c), t).alias(c) for c, t in df.schema.items()])
    header = pl.DataFrame([df.columns], schema=df.columns, orient="row")
    return pl.concat([header, df]).rename({c: f"Column{i + 1}" for i, c in enumerate(df.columns)}).lazy()`,
  };

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

  const PY_RESERVED = ('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield ' +
    'print sorted len range str int float bool list dict set tuple min max sum abs round zip enumerate any all open isinstance next map filter type object id input format repr hash iter reversed slice').split(' ');

  S.toPython = function (project, onlyQueryId) {
    const { order, deps } = S.topo(project);
    const byId = new Map(project.queries.map((q) => [q.id, q]));
    let ids = order;
    if (onlyQueryId) { const need = new Set(); const add = (id) => { if (need.has(id)) return; need.add(id); deps(byId.get(id)).forEach(add); }; add(onlyQueryId); ids = order.filter((id) => need.has(id)); }
    const vars = {}, used = new Set(['pl', 'lf', 'params', 'data_dir', 'fnmatch', 'fastexcel', 'date'].concat(Object.keys(HELPERS).filter((n) => n.startsWith('def ')).map((n) => n.slice(4)), PY_RESERVED));
    ids.forEach((id) => { const v = PQ.uniqueName(PQ.snake(byId.get(id).name), used); used.add(v); vars[id] = v; });
    const helpers = new Set();
    const blocks = ids.map((id) => {
      const q = byId.get(id);
      const steps = q.steps.filter((s) => !s.disabled);
      const src = steps[0] && steps[0].kind.type === 'Source' ? sourceCode(steps[0].kind.source, vars, helpers, project) : 'pl.LazyFrame()';
      const depSet = new Set(deps(byId.get(id)));
      const sqlRefs = project.queries.filter((o) => ids.includes(o.id) && o.id !== id && depSet.has(o.id)).map((o) => ({ alias: PQ.snake(o.name), var: vars[o.id] }));
      const body = steps.slice(1).map((s) => {
        const code = stepCode(s.kind, { vars, helpers, loc: project.settings.locale, sqlRefs });
        if (code.includes('floe_proper(')) helpers.add('def floe_proper');
        if (code.includes('floe_parse_number(')) helpers.add('def floe_parse_number');
        if (code.includes('floe_parse_datetime(')) helpers.add('def floe_parse_datetime');
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
      helpers.add('def floe_csv_ready');
      return `    ${v}.pipe(floe_csv_ready).sink_csv(OUT_DIR / "${f}.csv", date_format="%Y-%m-%d", datetime_format="%Y-%m-%d %H:%M:%S")`;
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

  S.FORMAT_VERSION = 1;
  S.toFiles = function (project) {
    const files = {};
    const qfile = (q) => 'queries/' + PQ.snake(q.name) + '.json';
    files['project.json'] = PQ.stableStringify({ format_version: S.FORMAT_VERSION, name: project.name, settings: project.settings, params: project.params || [], queries: project.queries.map((q) => ({ id: q.id, file: qfile(q) })) }, 2) + '\n';
    project.queries.forEach((q) => { files[qfile(q)] = PQ.stableStringify(q, 2) + '\n'; });
    return files;
  };
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
