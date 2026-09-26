/* Step dialogs: one form per step kind, all with an instant live preview (a "draft" step evaluated by
 * the engine on the preview sample) and schema-aware column pickers. */
(function () {
  const PQ = self.PQ, UI = PQ.UI, h = UI.h, Store = UI.Store;

  /* ================================ form widgets ================================ */
  const W = (UI.W = {});
  W.field = (label, input, help) => h('div.field', h('label', label), input, help ? h('div.help', help) : null);
  W.text = (value, attrs) => h('input.input', Object.assign({ value: value === undefined || value === null ? '' : value }, attrs || {}));
  W.num = (value, attrs) => h('input.input', Object.assign({ type: 'number', value: value === undefined || value === null ? '' : value }, attrs || {}));
  W.select = (options, value, attrs) => {
    const s = h('select.input', attrs || {});
    options.forEach((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; s.appendChild(h('option', { value: v, selected: String(v) === String(value) }, l)); });
    return s;
  };
  W.colSelect = (schema, value, opts) => {
    opts = opts || {};
    const s = h('select.input', opts.attrs || {});
    if (opts.empty) s.appendChild(h('option', { value: '' }, opts.empty));
    schema.forEach((c) => s.appendChild(h('option', { value: c.name, selected: c.name === value }, (PQ.TYPES[c.type] || PQ.TYPES.any).icon + '  ' + c.name)));
    if (value && !schema.some((c) => c.name === value)) s.appendChild(h('option', { value, selected: true }, '⚠ ' + value + ' (missing)'));
    return s;
  };
  /** Multi-select as toggle pills. Returns element with .get() */
  W.colMulti = (schema, values, onChange) => {
    const set = new Set(values || []);
    const el = h('div.pill-select', { role: 'group' });
    const missing = [...set].filter((v) => !schema.some((c) => c.name === v)).map((v) => ({ name: v, type: 'any', missing: true }));
    schema.concat(missing).forEach((c) => {
      const lab = h('label', { class: set.has(c.name) ? 'on' : '', title: c.missing ? 'Column not found in input' : PQ.TYPES[c.type].label },
        h('input', { type: 'checkbox', checked: set.has(c.name) }), UI.typeChip(c.type), (c.missing ? '⚠ ' : '') + c.name);
      lab.querySelector('input').addEventListener('change', (e) => { if (e.target.checked) set.add(c.name); else set.delete(c.name); lab.classList.toggle('on', e.target.checked); onChange && onChange(); });
      el.appendChild(lab);
    });
    const order = schema.map((c) => c.name).concat(missing.map((m) => m.name));
    el.get = () => order.filter((n) => set.has(n));
    const bar = h('div.row', { style: { fontSize: '11px' } },
      h('button.link-btn', { type: 'button', on: { click: () => { order.forEach((n) => set.add(n)); el.querySelectorAll('label').forEach((l) => { l.classList.add('on'); l.querySelector('input').checked = true; }); onChange && onChange(); } } }, 'Select all'),
      h('button.link-btn', { type: 'button', on: { click: () => { set.clear(); el.querySelectorAll('label').forEach((l) => { l.classList.remove('on'); l.querySelector('input').checked = false; }); onChange && onChange(); } } }, 'Clear'));
    const wrap = h('div.col', { style: { gap: '4px' } }, el, bar);
    wrap.get = el.get;
    return wrap;
  };
  /** Repeating rows editor. make(item) → {el, get}. */
  W.rows = (items, make, blank, addLabel, onChange) => {
    const list = h('div.list-rows');
    const rows = [];
    const add = (it) => {
      const r = make(it, onChange);
      const rowEl = h('div.list-row', h('div.grow', r.el), h('button.icon-btn.danger', { type: 'button', 'aria-label': 'Remove', on: { click: () => { rows.splice(rows.indexOf(r), 1); rowEl.remove(); onChange && onChange(); } } }, UI.icon('fa-xmark')));
      rows.push(r); list.appendChild(rowEl);
    };
    (items && items.length ? items : [blank()]).forEach(add);
    const el = h('div.col', list, h('div', h('button.btn.sm', { type: 'button', on: { click: () => { add(blank()); onChange && onChange(); } } }, UI.icon('fa-plus'), addLabel || 'Add')));
    el.get = () => rows.map((r) => r.get());
    return el;
  };
  const onAny = (el, f) => { el.addEventListener('input', f); el.addEventListener('change', f); return el; };

  /* ================================ forms per step kind ================================ */
  const TYPE_OPTS = Object.keys(PQ.TYPES).filter((t) => t !== 'any').map((t) => [t, PQ.TYPES[t].icon + '  ' + PQ.TYPES[t].label]);
  const AGG_OPTS = () => Object.keys(PQ.Engine ? PQ.Engine.AGG : {}).map((k) => [k, PQ.Engine.AGG[k].label]);

  const F = {};
  UI.StepForms = F;

  F.SelectColumns = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed); return { el: W.field('Columns to keep (in this order)', m), get: () => ({ type: 'SelectColumns', cols: m.get() }) }; };
  F.RemoveColumns = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed); return { el: W.field('Columns to remove', m), get: () => ({ type: 'RemoveColumns', cols: m.get() }) }; };
  F.ReorderColumns = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed); return { el: W.field('Move these columns to the front', m), get: () => ({ type: 'ReorderColumns', cols: m.get() }) }; };
  F.Rename = (k, ctx) => {
    const r = W.rows(k.map, (p, ch) => { const a = W.colSelect(ctx.schema, p[0]), b = W.text(p[1], { placeholder: 'New name' }); onAny(a, ch); onAny(b, ch); return { el: h('div.grid-2', a, b), get: () => [a.value, b.value.trim()] }; }, () => [ctx.schema[0] ? ctx.schema[0].name : '', ''], 'Add rename', ctx.changed);
    return { el: W.field('Rename columns', r), get: () => ({ type: 'Rename', map: r.get().filter((p) => p[0] && p[1] && p[0] !== p[1]) }) };
  };
  F.ChangeType = (k, ctx) => {
    const r = W.rows(k.changes, (c, ch) => {
      const a = W.colSelect(ctx.schema, c.col), b = W.select(TYPE_OPTS, c.type || 'text'), l = W.select([['', 'Project locale']].concat(Object.keys(PQ.LOCALES).map((x) => [x, x])), c.locale || '');
      [a, b, l].forEach((x) => onAny(x, ch));
      return { el: h('div.grid-3', a, b, l), get: () => ({ col: a.value, type: b.value, locale: l.value || undefined }) };
    }, () => ({ col: ctx.schema[0] ? ctx.schema[0].name : '', type: 'text' }), 'Add column', ctx.changed);
    const onErr = onAny(W.select([['error', 'Mark cell as error'], ['null', 'Set to null'], ['keep', 'Null + <col>_error column'], ['fail', 'Fail step']], k.onError || 'error'), ctx.changed);
    return {
      el: h('div.col', W.field('Column · Type · Locale', r), W.field('On conversion error', onErr)),
      get: () => ({ type: 'ChangeType', changes: r.get().filter((c) => c.col), onError: onErr.value }),
    };
  };
  F.Filter = (k, ctx) => {
    let mode = k.mode || 'builder';
    const b = k.builder || { join: 'and', conds: [{ col: ctx.focusCol || (ctx.schema[0] || {}).name, op: 'eq', value: '' }] };
    const OPS = [['eq', 'equals'], ['ne', 'does not equal'], ['gt', 'greater than'], ['ge', 'greater or equal'], ['lt', 'less than'], ['le', 'less or equal'], ['contains', 'contains'], ['not_contains', 'does not contain'], ['starts', 'begins with'], ['ends', 'ends with'], ['null', 'is null'], ['not_null', 'is not null']];
    const join = onAny(W.select([['and', 'All conditions (AND)'], ['or', 'Any condition (OR)']], b.join), ctx.changed);
    const conds = W.rows(b.conds.filter((c) => c.op !== 'in' && c.op !== 'not_in'), (c, ch) => {
      const col = W.colSelect(ctx.schema, c.col), op = W.select(OPS, c.op), val = W.text(c.value, { placeholder: 'Value (@Param allowed in advanced mode)' });
      const sync = () => { val.style.visibility = op.value === 'null' || op.value === 'not_null' ? 'hidden' : ''; };
      [col, op, val].forEach((x) => onAny(x, () => { sync(); ch(); }));
      sync();
      return { el: h('div.grid-3', col, op, val), get: () => ({ col: col.value, op: op.value, value: val.value, numeric: !['contains', 'not_contains', 'starts', 'ends'].includes(op.value) && ['int', 'number'].includes((ctx.schema.find((s) => s.name === col.value) || {}).type) }) };
    }, () => ({ col: (ctx.schema[0] || {}).name, op: 'eq', value: '' }), 'Add condition', ctx.changed);
    const inList = b.conds.filter((c) => c.op === 'in' || c.op === 'not_in');
    const fx = UI.formulaEditor({ value: k.formula || (k.builder ? PQ.Engine.builderToFormula(k.builder) : ''), schema: ctx.schema, params: ctx.params, onChange: ctx.changed, emptyText: 'A True/False formula, e.g. [Sales] > 1000 and [Region] = "EU"' });
    const builderEl = h('div.col', W.field('Keep rows where', join), conds, inList.length ? h('div.faint', { style: { fontSize: '12px' } }, 'And ', h('code', PQ.Engine.builderToFormula({ conds: inList }))) : null);
    const advEl = h('div', W.field('Keep rows where this formula is true', fx.el));
    const seg = h('div.seg', h('button', { type: 'button', class: mode === 'builder' ? 'on' : '' }, 'Basic'), h('button', { type: 'button', class: mode === 'advanced' ? 'on' : '' }, 'Advanced (formula)'));
    const show = () => { builderEl.classList.toggle('hidden', mode !== 'builder'); advEl.classList.toggle('hidden', mode !== 'advanced'); seg.children[0].classList.toggle('on', mode === 'builder'); seg.children[1].classList.toggle('on', mode === 'advanced'); };
    seg.children[0].addEventListener('click', () => { mode = 'builder'; show(); ctx.changed(); });
    seg.children[1].addEventListener('click', () => { if (mode === 'builder') fx.set(PQ.Engine.builderToFormula(getBuilder())); mode = 'advanced'; show(); ctx.changed(); });
    const getBuilder = () => ({ join: join.value, conds: conds.get().filter((c) => c.col).concat(inList) });
    show();
    return { el: h('div.col', seg, builderEl, advEl), get: () => (mode === 'builder' ? { type: 'Filter', mode: 'builder', builder: getBuilder() } : { type: 'Filter', mode: 'advanced', formula: fx.get() }), valid: () => mode === 'builder' || (fx.validation() && fx.validation().ok) };
  };
  F.Sort = (k, ctx) => {
    const r = W.rows(k.by, (b, ch) => { const c = W.colSelect(ctx.schema, b.col), d = W.select([['asc', 'Ascending ↑'], ['desc', 'Descending ↓']], b.desc ? 'desc' : 'asc'); onAny(c, ch); onAny(d, ch); return { el: h('div.grid-2', c, d), get: () => ({ col: c.value, desc: d.value === 'desc', nullsLast: true }) }; }, () => ({ col: (ctx.schema[0] || {}).name }), 'Add sort level', ctx.changed);
    return { el: W.field('Sort by (first level wins)', r, 'Stable sort, nulls last — matches Polars sort(maintain_order=True, nulls_last=True).'), get: () => ({ type: 'Sort', by: r.get() }) };
  };
  F.Distinct = (k, ctx) => { const m = W.colMulti(ctx.schema, k.subset, ctx.changed); return { el: W.field('Compare these columns (none = all columns)', m, 'Keeps the first occurrence of each distinct combination.'), get: () => ({ type: 'Distinct', subset: m.get() }) }; };
  F.KeepDuplicates = (k, ctx) => { const m = W.colMulti(ctx.schema, k.subset, ctx.changed); return { el: W.field('Compare these columns (none = all)', m), get: () => ({ type: 'KeepDuplicates', subset: m.get() }) }; };
  F.KeepRows = (k, ctx) => {
    const mode = onAny(W.select([['top', 'Keep top rows'], ['bottom', 'Keep bottom rows'], ['range', 'Keep range of rows'], ['remove_top', 'Remove top rows'], ['remove_bottom', 'Remove bottom rows'], ['alternate', 'Keep alternate rows'], ['remove_blank', 'Remove blank rows']], k.mode || 'top'), ctx.changed);
    const n = onAny(W.num(k.n === undefined ? 10 : k.n, { min: 0 }), ctx.changed), off = onAny(W.num(k.offset || 0, { min: 0 }), ctx.changed), keep = onAny(W.num(k.keep || 1, { min: 1 }), ctx.changed), skip = onAny(W.num(k.skip || 1, { min: 0 }), ctx.changed);
    const fN = W.field('Number of rows', n), fO = W.field('First row (0-based offset)', off), fK = W.field('Keep', keep), fS = W.field('Then skip', skip);
    const sync = () => { const m = mode.value; fN.classList.toggle('hidden', m === 'alternate' || m === 'remove_blank'); fO.classList.toggle('hidden', m !== 'range' && m !== 'alternate'); fK.classList.toggle('hidden', m !== 'alternate'); fS.classList.toggle('hidden', m !== 'alternate'); };
    mode.addEventListener('change', sync); sync();
    return { el: h('div.col', W.field('Operation', mode), h('div.grid-2', fN, fO, fK, fS)), get: () => ({ type: 'KeepRows', mode: mode.value, n: +n.value, offset: +off.value, keep: +keep.value, skip: +skip.value }) };
  };
  F.PromoteHeaders = (k, ctx) => { const r = onAny(W.num((k.row || 0) + 1, { min: 1 }), ctx.changed); return { el: W.field('Header row (1-based)', r, 'Rows above the header row are dropped — useful for report-style sheets with titles on top.'), get: () => ({ type: 'PromoteHeaders', row: Math.max(0, (+r.value || 1) - 1) }) }; };
  F.DemoteHeaders = () => ({ el: h('p.muted', 'Moves the column names into the first row and names columns Column1, Column2, …'), get: () => ({ type: 'DemoteHeaders' }) });
  const fillForm = (type) => (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed); return { el: W.field('Columns', m, type === 'FillDown' ? 'Replaces empty cells with the last non-empty value above — the fix for merged cells and grouped report layouts.' : 'Replaces empty cells with the next non-empty value below.'), get: () => ({ type, cols: m.get() }) }; };
  F.FillDown = fillForm('FillDown'); F.FillUp = fillForm('FillUp');
  F.ReplaceValues = (k, ctx) => {
    const m = W.colMulti(ctx.schema, k.cols, ctx.changed), a = onAny(W.text(k.find, { placeholder: 'empty = null' }), ctx.changed), b = onAny(W.text(k.replace, { placeholder: 'empty = null' }), ctx.changed);
    const whole = h('input', { type: 'checkbox', checked: k.wholeCell !== false }); onAny(whole, ctx.changed);
    return { el: h('div.col', W.field('In columns', m), h('div.grid-2', W.field('Value to find', a), W.field('Replace with', b)), h('label.check', whole, 'Match entire cell contents (unchecked = replace substring in text)')), get: () => ({ type: 'ReplaceValues', cols: m.get(), find: a.value === '' ? null : a.value, replace: b.value === '' ? null : b.value, wholeCell: whole.checked }) };
  };
  F.ReplaceErrors = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed), v = onAny(W.text(k.value, { placeholder: 'empty = null' }), ctx.changed); return { el: h('div.col', W.field('Columns', m), W.field('Replace errors with', v)), get: () => ({ type: 'ReplaceErrors', cols: m.get(), value: v.value }) }; };
  F.RemoveErrors = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed); return { el: W.field('Remove rows with an error in (none = any column)', m), get: () => ({ type: 'RemoveErrors', cols: m.get() }) }; };
  F.KeepErrors = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed); return { el: W.field('Keep only rows with an error in (none = any column)', m), get: () => ({ type: 'KeepErrors', cols: m.get() }) }; };
  F.TextTransform = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed), op = onAny(W.select([['trim', 'Trim'], ['clean', 'Clean (control chars + repeated spaces)'], ['upper', 'UPPERCASE'], ['lower', 'lowercase'], ['proper', 'Capitalize Each Word']], k.op || 'trim'), ctx.changed); return { el: h('div.col', W.field('Transform', op), W.field('Columns', m)), get: () => ({ type: 'TextTransform', op: op.value, cols: m.get() }) }; };
  F.RoundNumbers = (k, ctx) => { const m = W.colMulti(ctx.schema.filter((c) => c.type === 'number' || c.type === 'int' || c.type === 'any'), k.cols, ctx.changed), d = onAny(W.num(k.digits || 0, { min: 0, max: 12 }), ctx.changed); return { el: h('div.col', W.field('Decimal places', d), W.field('Columns', m)), get: () => ({ type: 'RoundNumbers', cols: m.get(), digits: +d.value }) }; };
  F.SplitColumn = (k, ctx) => {
    const col = onAny(W.colSelect(ctx.schema, k.col || ctx.focusCol), ctx.changed);
    const mode = onAny(W.select([['each', 'At each occurrence of the delimiter'], ['first', 'At the left-most delimiter'], ['last', 'At the right-most delimiter'], ['rows', 'Into rows (one row per piece)'], ['positions', 'At character positions']], k.mode || 'each'), ctx.changed);
    const delim = onAny(W.text(k.delimiter === undefined ? ',' : k.delimiter), ctx.changed), pos = onAny(W.text(k.positions || '0, 3', { placeholder: '0, 3, 7' }), ctx.changed), count = onAny(W.num(k.count || '', { placeholder: 'auto', min: 1 }), ctx.changed);
    const trim = h('input', { type: 'checkbox', checked: k.trim !== false }); onAny(trim, ctx.changed);
    const fD = W.field('Delimiter (\\t = tab)', delim), fP = W.field('Positions (0-based)', pos), fC = W.field('Number of columns', count);
    const sync = () => { fD.classList.toggle('hidden', mode.value === 'positions'); fP.classList.toggle('hidden', mode.value !== 'positions'); fC.classList.toggle('hidden', mode.value !== 'each'); };
    mode.addEventListener('change', sync); sync();
    return { el: h('div.col', h('div.grid-2', W.field('Column', col), W.field('Split', mode)), h('div.grid-3', fD, fP, fC), h('label.check', trim, 'Trim whitespace from pieces')), get: () => ({ type: 'SplitColumn', col: col.value, mode: mode.value, delimiter: delim.value.replace(/\\t/g, '\t'), positions: pos.value, count: count.value ? +count.value : undefined, trim: trim.checked }) };
  };
  F.MergeColumns = (k, ctx) => { const m = W.colMulti(ctx.schema, k.cols, ctx.changed), sep = onAny(W.text(k.sep === undefined ? ' ' : k.sep), ctx.changed), nm = onAny(W.text(k.name || 'Merged'), ctx.changed); return { el: h('div.col', W.field('Columns (in order)', m), h('div.grid-2', W.field('Separator', sep), W.field('New column name', nm))), get: () => ({ type: 'MergeColumns', cols: m.get(), sep: sep.value, name: nm.value.trim() || 'Merged' }) }; };
  F.AddColumn = (k, ctx) => {
    const nm = onAny(W.text(k.name || PQ.uniqueName('Custom', ctx.schema.map((c) => c.name)), { autofocus: true }), ctx.changed);
    const typ = onAny(W.select([['auto', 'Automatic']].concat(TYPE_OPTS), k.castTo || 'auto'), ctx.changed);
    const fx = UI.formulaEditor({ value: k.formula || '', schema: ctx.schema, params: ctx.params, onChange: ctx.changed });
    const cols = h('div.pill-select', { style: { maxHeight: '110px' } }, ctx.schema.map((c) => h('label', { title: 'Insert ' + c.name, on: { click: (e) => { e.preventDefault(); fx.insert(PQ.Formula.quoteCol(c.name)); } } }, UI.typeChip(c.type), c.name)));
    return { el: h('div.col', h('div.grid-2', W.field('New column name', nm), W.field('Type', typ)), W.field('Formula', fx.el), W.field('Available columns (click to insert)', cols)), get: () => ({ type: 'AddColumn', name: nm.value.trim(), formula: fx.get(), castTo: typ.value !== 'auto' ? typ.value : undefined }), valid: () => fx.validation() && fx.validation().ok && nm.value.trim() };
  };
  F.ConditionalColumn = (k, ctx) => {
    const nm = onAny(W.text(k.name || PQ.uniqueName('Category', ctx.schema.map((c) => c.name))), ctx.changed);
    const editors = [];
    const r = W.rows(k.rules, (rule, ch) => {
      const w = UI.formulaEditor({ value: rule.when || '', schema: ctx.schema, params: ctx.params, single: true, noHelp: true, onChange: ch, emptyText: 'Condition, e.g. [Sales] > 1000' });
      const t = UI.formulaEditor({ value: rule.then || '', schema: ctx.schema, params: ctx.params, single: true, noHelp: true, onChange: ch, emptyText: 'Output, e.g. "High"' });
      editors.push(w, t);
      return { el: h('div.grid-2', h('div', h('div.field-label', 'If'), w.el), h('div', h('div.field-label', 'Then'), t.el)), get: () => ({ when: w.get(), then: t.get() }) };
    }, () => ({ when: '', then: '' }), 'Add clause', ctx.changed);
    const els = UI.formulaEditor({ value: k.else || 'null', schema: ctx.schema, params: ctx.params, single: true, noHelp: true, onChange: ctx.changed });
    return { el: h('div.col', W.field('New column name', nm), r, W.field('Else', els.el)), get: () => ({ type: 'ConditionalColumn', name: nm.value.trim(), rules: r.get().filter((x) => x.when.trim()), else: els.get() }), valid: () => nm.value.trim() && editors.every((e) => !e.get().trim() || (e.validation() && e.validation().ok)) };
  };
  F.IndexColumn = (k, ctx) => { const nm = onAny(W.text(k.name || 'Index'), ctx.changed), s = onAny(W.num(k.start === undefined ? 1 : k.start), ctx.changed), st = onAny(W.num(k.step === undefined ? 1 : k.step), ctx.changed); const first = h('input', { type: 'checkbox', checked: k.first !== false }); onAny(first, ctx.changed); return { el: h('div.col', h('div.grid-3', W.field('Name', nm), W.field('Start', s), W.field('Increment', st)), h('label.check', first, 'Insert as first column')), get: () => ({ type: 'IndexColumn', name: nm.value.trim() || 'Index', start: +s.value, step: +st.value, first: first.checked }) }; };
  F.DuplicateColumn = (k, ctx) => { const c = onAny(W.colSelect(ctx.schema, k.col || ctx.focusCol), ctx.changed), nm = onAny(W.text(k.name || ''), { placeholder: '<column> - Copy' }); onAny(nm, ctx.changed); return { el: h('div.grid-2', W.field('Column', c), W.field('New name', nm)), get: () => ({ type: 'DuplicateColumn', col: c.value, name: nm.value.trim() || undefined }) }; };
  F.GroupBy = (k, ctx) => {
    const keys = W.colMulti(ctx.schema, k.keys, ctx.changed);
    const numCols = ctx.schema.filter((c) => c.type === 'int' || c.type === 'number');
    const aggs = W.rows(k.aggs, (a, ch) => {
      const nm = W.text(a.name || '', { placeholder: 'Output name (auto)' }), fn = W.select(AGG_OPTS(), a.fn || 'sum'), col = W.colSelect(ctx.schema, a.col || (numCols[0] || ctx.schema[0] || {}).name);
      const sync = () => { col.style.visibility = fn.value === 'count_rows' ? 'hidden' : ''; };
      [nm, fn, col].forEach((x) => onAny(x, () => { sync(); ch(); })); sync();
      return { el: h('div.grid-3', nm, fn, col), get: () => ({ name: nm.value.trim() || undefined, fn: fn.value, col: fn.value === 'count_rows' ? undefined : col.value }) };
    }, () => ({ fn: 'count_rows', name: 'Count' }), 'Add aggregation', ctx.changed);
    return { el: h('div.col', W.field('Group by (none = aggregate the whole table)', keys), W.field('Aggregations · Name · Operation · Column', aggs)), get: () => ({ type: 'GroupBy', keys: keys.get(), aggs: aggs.get() }) };
  };
  F.Unpivot = (k, ctx) => {
    const mode = onAny(W.select([['ids', 'Keep these columns, unpivot all others'], ['values', 'Unpivot only these columns']], k.values && k.values.length ? 'values' : 'ids'), ctx.changed);
    const m = W.colMulti(ctx.schema, k.values && k.values.length ? k.values : k.ids, ctx.changed);
    const v = onAny(W.text(k.var || 'Attribute'), ctx.changed), val = onAny(W.text(k.val || 'Value'), ctx.changed);
    return { el: h('div.col', W.field('Mode', mode), W.field('Columns', m), h('div.grid-2', W.field('Attribute column', v), W.field('Value column', val))), get: () => mode.value === 'ids' ? { type: 'Unpivot', ids: m.get(), var: v.value || 'Attribute', val: val.value || 'Value' } : { type: 'Unpivot', ids: ctx.schema.map((c) => c.name).filter((n) => !m.get().includes(n)), values: m.get(), var: v.value || 'Attribute', val: val.value || 'Value' } };
  };
  F.Pivot = (k, ctx) => {
    const on = onAny(W.colSelect(ctx.schema, k.on || ctx.focusCol), ctx.changed), vals = onAny(W.colSelect(ctx.schema, k.values, { empty: '(count rows)' }), ctx.changed), agg = onAny(W.select(AGG_OPTS().filter(([x]) => x !== 'count_rows' && x !== 'concat'), k.agg || 'sum'), ctx.changed);
    const idx = W.colMulti(ctx.schema, k.index, ctx.changed);
    return { el: h('div.col', h('div.grid-3', W.field('Column whose values become headers', on), W.field('Values column', vals), W.field('Aggregate', agg)), W.field('Row index (none = all others)', idx), h('div.faint', { style: { fontSize: '12px' } }, UI.icon('fa-bolt', 'tag-mat'), ' Materializes')), get: () => ({ type: 'Pivot', on: on.value, values: vals.value || undefined, agg: vals.value ? agg.value : 'count_rows', index: idx.get() }) };
  };
  F.Transpose = (k, ctx) => { const c = onAny(W.colSelect(ctx.schema, k.headerCol, { empty: '(none — Column1, Column2…)' }), ctx.changed); return { el: h('div.col', W.field('Header column', c), h('div.faint', { style: { fontSize: '12px' } }, UI.icon('fa-bolt', 'tag-mat'), ' Materializes')), get: () => ({ type: 'Transpose', headerCol: c.value || undefined }) }; };
  F.Append = (k, ctx) => {
    const others = h('div.pill-select');
    const set = new Set(k.others || []);
    ctx.queries.filter((q) => q.id !== ctx.qid).forEach((q) => { const lab = h('label', { class: set.has(q.id) ? 'on' : '' }, h('input', { type: 'checkbox', checked: set.has(q.id) }), UI.icon('fa-table'), q.name); lab.querySelector('input').addEventListener('change', (e) => { if (e.target.checked) set.add(q.id); else set.delete(q.id); lab.classList.toggle('on', e.target.checked); ctx.changed(); }); others.appendChild(lab); });
    const mode = onAny(W.select([['diagonal', 'Diagonal — union columns by name, fill missing with null'], ['strict', 'Strict — all tables must have the same columns']], k.mode || 'diagonal'), ctx.changed);
    return { el: h('div.col', W.field('Append these queries below the current one', others), W.field('Mode', mode)), get: () => ({ type: 'Append', others: [...set], mode: mode.value }) };
  };
  F.Window = (k, ctx) => {
    const op = onAny(W.select([['cumsum', 'Running total'], ['row_number', 'Row number'], ['rank', 'Rank (descending)'], ['lag', 'Previous value (lag)'], ['lead', 'Next value (lead)'], ['pct_of_total', '% of total'], ['moving_avg', 'Moving average']], k.op || 'cumsum'), ctx.changed);
    const col = onAny(W.colSelect(ctx.schema, k.col || ctx.focusCol), ctx.changed), nm = onAny(W.text(k.name || ''), { placeholder: 'auto' }); onAny(nm, ctx.changed);
    const part = W.colMulti(ctx.schema, k.partition, ctx.changed), ord = onAny(W.colSelect(ctx.schema, k.orderBy, { empty: '(current order)' }), ctx.changed), n = onAny(W.num(k.n || 1, { min: 1 }), ctx.changed);
    const fN = W.field('N (offset / window)', n), fC = W.field('Column', col);
    const sync = () => { fN.classList.toggle('hidden', !['lag', 'lead', 'moving_avg'].includes(op.value)); fC.classList.toggle('hidden', op.value === 'row_number'); };
    op.addEventListener('change', sync); sync();
    return { el: h('div.col', h('div.grid-3', W.field('Operation', op), fC, W.field('New column name', nm)), h('div.grid-2', W.field('Order by', ord), fN), W.field('Partition by (restart per group)', part)), get: () => ({ type: 'Window', op: op.value, col: op.value === 'row_number' ? undefined : col.value, name: nm.value.trim() || ({ cumsum: 'Running total', row_number: 'Row number', rank: 'Rank', lag: 'Previous', lead: 'Next', pct_of_total: '% of total', moving_avg: 'Moving avg' }[op.value]), partition: part.get(), orderBy: ord.value || undefined, n: +n.value }) };
  };
  F.ExpandJson = (k, ctx) => { const c = onAny(W.colSelect(ctx.schema, k.col || ctx.focusCol), ctx.changed); return { el: h('div.col', W.field('Column containing JSON', c), h('p.muted', { style: { margin: 0 } }, 'Objects expand into columns (ExpandStruct); arrays expand into rows (ExplodeList).')), get: () => ({ type: 'ExpandJson', col: c.value }) }; };
  F.CustomSql = (k, ctx) => {
    const ta = h('textarea.input.mono', { rows: 8, spellcheck: 'false', style: { fontFamily: 'var(--mono)', fontSize: '12.5px' } });
    ta.value = k.sql || 'SELECT *\nFROM self\nLIMIT 100';
    onAny(ta, PQ.debounce(ctx.changed, 400));
    const refs = ctx.queries.filter((q) => q.id !== ctx.qid).map((q) => h('code', { style: { marginRight: '8px' } }, PQ.snake(q.name)));
    return { el: h('div.col', W.field('SQL', ta), h('div.faint', { style: { fontSize: '12px' } }, h('code', 'self'), ' = previous step', refs.length ? [' · ', refs] : null), h('div.faint', { style: { fontSize: '11px' } }, 'Columns: ', ctx.schema.map((c) => c.name).join(', '))), get: () => ({ type: 'CustomSql', sql: ta.value }) };
  };
  F.Checkpoint = () => ({ el: h('p.muted', 'Materializes the result here and caches it (Power Query\'s Table.Buffer). Useful before expensive branches that reuse the same intermediate result.'), get: () => ({ type: 'Checkpoint' }) });

  /* ---------- Source editing ---------- */
  F.Source = (k, ctx) => {
    const s = JSON.parse(JSON.stringify(k.source || {}));
    if (s.kind === 'query') {
      const q = onAny(W.select(ctx.queries.filter((x) => x.id !== ctx.qid).map((x) => [x.id, x.name]), s.query), ctx.changed);
      return { el: W.field('Reference query', q), get: () => ({ type: 'Source', source: { kind: 'query', query: q.value } }) };
    }
    if (s.kind === 'folder') {
      const f = onAny(W.select(UI.App.folders(), s.folder), ctx.changed), p = onAny(W.text(s.pattern || '*.csv'), ctx.changed), d = onAny(W.text((s.csv && s.csv.delimiter) || ';'), ctx.changed), fc = onAny(W.text(s.fileColumn || 'Source.Name'), ctx.changed);
      return { el: h('div.col', h('div.grid-2', W.field('Folder', f), W.field('File pattern', p)), h('div.grid-2', W.field('CSV delimiter', d), W.field('File name column', fc))), get: () => ({ type: 'Source', source: Object.assign(s, { kind: 'folder', folder: f.value, pattern: p.value, csv: Object.assign({}, s.csv, { delimiter: d.value.replace(/\\t/g, '\t') }), fileColumn: fc.value || 'Source.Name' }) }) };
    }
    if (s.kind === 'blank') {
      const ta = h('textarea.input.mono', { rows: 8 }); ta.value = [(s.columns || []).join('\t')].concat((s.rows || []).map((r) => r.join('\t'))).join('\n');
      onAny(ta, PQ.debounce(ctx.changed, 300));
      return { el: W.field('Data (tab-separated, first line = headers; paste from Excel works)', ta), get: () => { const lines = ta.value.split(/\r?\n/).filter((l) => l.length); const cols = (lines[0] || 'Column1').split('\t'); return { type: 'Source', source: { kind: 'blank', columns: cols, rows: lines.slice(1).map((l) => l.split('\t')) } }; } };
    }
    // file
    const files = UI.App.files.filter((f) => !f.folder);
    const file = onAny(W.select(files.map((f) => [f.id, f.name]).concat(files.some((f) => f.id === s.fileId) ? [] : [[s.fileId || '', '⚠ ' + (s.fileName || 'missing file')]]), s.fileId), ctx.changed);
    const kind = PQ.IO ? null : null;
    const isExcel = /\.(xlsx|xlsm|xlsb|xls|ods)$/i.test(s.fileName || '');
    const parts = [W.field('File', file)];
    let get;
    if (isExcel) {
      const it = s.item || { type: 'sheet', name: '' };
      const t = onAny(W.select([['table', 'Excel Table'], ['sheet', 'Whole sheet'], ['range', 'Sheet range (A1)'], ['name', 'Named range'], ['sheets', 'Combine sheets matching a pattern']], it.type), ctx.changed);
      const nm = onAny(W.text(it.type === 'sheets' ? it.pattern : it.name || it.sheet || ''), ctx.changed), rg = onAny(W.text(it.range || '', { placeholder: 'B3:H or B3:H500' }), ctx.changed);
      const fm = h('input', { type: 'checkbox', checked: !!s.fillMerged }); onAny(fm, ctx.changed);
      const fR = W.field('Range', rg);
      const sync = () => fR.classList.toggle('hidden', t.value !== 'range'); t.addEventListener('change', sync); sync();
      parts.push(h('div.grid-3', W.field('Item type', t), W.field('Name / sheet / pattern', nm), fR), h('label.check', fm, 'Fill merged cells with their top-left value'), h('button.btn.sm', { type: 'button', style: { justifySelf: 'start' }, on: { click: () => { ctx.close(); UI.App.openNavigator(file.value, { replaceSourceOf: ctx.qid }); } } }, UI.icon('fa-sitemap'), 'Open navigator…'));
      get = () => { const f = UI.App.files.find((x) => x.id === file.value); const item = t.value === 'sheets' ? { type: 'sheets', pattern: nm.value || '*', sheetColumn: it.sheetColumn || '_sheet' } : t.value === 'range' ? { type: 'range', sheet: nm.value, range: rg.value } : { type: t.value, name: nm.value }; return { type: 'Source', source: Object.assign(s, { kind: 'file', fileId: file.value, fileName: f ? f.name : s.fileName, format: 'excel', item, fillMerged: fm.checked }) }; };
    } else {
      const c = s.csv || {};
      const d = onAny(W.select([[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']], c.delimiter || ','), ctx.changed);
      const enc = onAny(W.select([['auto', 'Auto-detect'], ['utf-8', 'UTF-8'], ['windows-1252', 'Windows-1252 (Western)'], ['iso-8859-1', 'ISO-8859-1'], ['utf-16le', 'UTF-16 LE']], c.encoding || 'auto'), ctx.changed);
      const skip = onAny(W.num(c.skipRows || 0, { min: 0 }), ctx.changed);
      const hd = h('input', { type: 'checkbox', checked: c.header !== false }); onAny(hd, ctx.changed);
      parts.push(h('div.grid-3', W.field('Delimiter', d), W.field('Encoding', enc), W.field('Skip rows', skip)), h('label.check', hd, 'First row contains headers'));
      get = () => { const f = UI.App.files.find((x) => x.id === file.value); return { type: 'Source', source: Object.assign(s, { kind: 'file', fileId: file.value, fileName: f ? f.name : s.fileName, csv: { delimiter: d.value, encoding: enc.value, skipRows: +skip.value, header: hd.checked } }) }; };
    }
    return { el: h('div.col', parts), get };
  };

  /* ================================ generic step dialog with live preview ================================ */
  /**
   * UI.editStep({qid, index}) edits an existing step; UI.editStep({qid, insertAt, kind}) adds a new one.
   * Every change re-evaluates a draft step on the preview sample.
   */
  UI.editStep = async function (o) {
    const q = Store.query(o.qid);
    if (!q) return;
    const editing = o.index !== undefined;
    const idx = editing ? o.index : o.insertAt;
    const kind = editing ? q.steps[o.index].kind : o.kind;
    if (kind.type === 'Merge') return UI.mergeDialog(o);
    let schema = [];
    if (idx > 0) {
      try { const r = await UI.Engine.call('schemaBefore', { qid: q.id, index: idx }); schema = r.schema; }
      catch (e) { UI.toast(e.message, 'err'); }
    }
    const preview = h('div.live-preview', h('div.lp-h', 'Preview'), h('div.mini-wrap', h('div.muted', { style: { padding: '10px' } }, 'Calculating…')));
    let form, seq = 0, modal;
    const nameInp = editing ? W.text(q.steps[o.index].name) : null;
    const noteInp = editing ? h('textarea.input', { rows: 2, placeholder: 'Why does this step exist? (saved in the project, exported as a comment)' }) : null;
    if (noteInp) noteInp.value = q.steps[o.index].note || '';
    const refresh = PQ.debounce(async () => {
      const my = ++seq;
      let draftKind;
      try { draftKind = currentKind(); } catch (e) { return; }
      const lp = preview.querySelector('.mini-wrap');
      if (form.valid && !form.valid()) { UI.clear(lp).appendChild(h('div.muted', { style: { padding: '10px' } }, 'Fix the highlighted input to see a preview.')); modal && modal.setOkEnabled(false); return; }
      modal && modal.setOkEnabled(true);
      try {
        const draft = editing ? { qid: q.id, index: idx, kind: draftKind } : { qid: q.id, insertAt: idx, kind: draftKind };
        const r = await UI.Engine.call('evaluate', { qid: q.id, upto: idx, draft, mode: 'preview', suggest: false });
        if (my !== seq) return;
        const st = r.states[idx];
        const hdr = preview.querySelector('.lp-h');
        UI.clear(hdr);
        if (!st || !st.ok) {
          UI.clear(lp).appendChild(h('div.callout.err', { style: { margin: '8px' } }, UI.icon('fa-circle-exclamation'), h('div', (st && st.error) || 'Error')));
          hdr.append(h('span', { style: { color: 'var(--err)' } }, 'Step error'));
          return;
        }
        const before = idx > 0 ? r.states[idx - 1] : null;
        hdr.append(h('b', PQ.fmtInt(r.n) + ' rows × ' + r.schema.length + ' columns'), before && before.ok ? h('span', '(before: ' + PQ.fmtInt(before.rows) + ' × ' + before.cols + ')') : null, h('span.grow'), h('span', UI.fmtMs(st.ms)), r.truncated ? h('span', { title: 'Based on the preview sample' }, '· sample') : null);
        const newCols = r.schema.map((c) => c.name).filter((n) => !schema.some((s) => s.name === n));
        UI.clear(lp).appendChild(UI.miniTable(r.schema, r.firstPage.slice(0, 30), { highlight: newCols }));
      } catch (e) {
        if (my !== seq) return;
        UI.clear(lp).appendChild(h('div.callout.err', { style: { margin: '8px' } }, UI.icon('fa-circle-exclamation'), h('div', e.message)));
      }
    }, 220);
    const ctx = { schema, params: Store.project.params, queries: Store.project.queries, qid: q.id, focusCol: o.focusCol, changed: () => refresh(), close: () => modal && modal.close() };
    const maker = F[kind.type];
    if (!maker) { UI.toast('No editor for ' + kind.type, 'err'); return; }
    form = maker(kind, ctx);
    function currentKind() {
      let k = form.get();
      if (form.post) k = form.post(k);
      delete k.type2;
      return k;
    }
    const body = h('div.col', { style: { gap: '14px' } },
      editing ? h('div.grid-2', W.field('Step name', nameInp), idx > 0 ? W.field('Input', h('div.muted', { style: { fontSize: '12px', paddingTop: '6px' } }, schema.length + ' columns from step ' + idx + ' (' + q.steps[idx - 1].name + ')')) : h('div')) : null,
      form.el,
      editing ? W.field('Note', noteInp) : null,
      preview);
    modal = UI.modal({
      title: (editing ? 'Edit step — ' : '') + PQ.Steps.label(kind.type), icon: PQ.Steps.icon(kind.type), size: 'wide', body, okLabel: editing ? 'Apply' : 'Add step',
      onOk: () => {
        if (form.valid && !form.valid()) { UI.toast('Invalid input', 'warn'); return false; }
        const k = currentKind();
        if (editing) {
          Store.edit('Edit ' + q.steps[o.index].name, (p) => {
            const st = p.queries.find((x) => x.id === q.id).steps[o.index];
            st.kind = k; st.name = nameInp.value.trim() || st.name; st.note = noteInp.value.trim() || undefined;
          });
        } else Store.addStep(k, { noFold: true });
      },
    });
    modal.footLeft.append(h('kbd', 'Ctrl'), h('kbd', 'Enter'));
    refresh();
  };

  /* ================================ Merge dialog (live match count) ================================ */
  UI.mergeDialog = async function (o) {
    const q = Store.query(o.qid);
    const editing = o.index !== undefined;
    const idx = editing ? o.index : o.insertAt;
    const k = JSON.parse(JSON.stringify(editing ? q.steps[o.index].kind : o.kind));
    const others = Store.project.queries.filter((x) => x.id !== q.id);
    if (!others.length) { UI.toast('Needs a second query', 'warn'); return; }
    k.right = k.right && others.some((x) => x.id === k.right) ? k.right : others[0].id;
    k.on = k.on || [];
    k.how = k.how || 'left';
    let leftSchema = [], rightSchema = [];
    const r0 = await UI.Engine.call('schemaBefore', { qid: q.id, index: idx });
    leftSchema = r0.schema;
    const leftPick = h('div'), rightPick = h('div'), stats = h('div'), expandBox = h('div');
    const rightSel = W.select(others.map((x) => [x.id, x.name]), k.right);
    const how = W.select([['left', 'Left outer — all from first, matching from second'], ['inner', 'Inner — only matching rows'], ['full', 'Full outer — all rows from both'], ['right', 'Right outer — all from second, matching from first'], ['semi', 'Left semi — rows in first that have a match (filter)'], ['anti', 'Left anti — rows in first with NO match'], ['cross', 'Cross join — every combination']], k.how);
    const prefix = W.text(k.prefix || '', { placeholder: 'Optional prefix for new columns' });
    let expand = k.expand || null;

    const keyList = (schema, side) => {
      const tbl = h('div.mini-wrap', { style: { maxHeight: '200px' } });
      const t = h('table.mini-table', h('thead', h('tr', schema.map((c) => {
        const pos = k.on.findIndex((p) => p[side] === c.name);
        return h('th', { class: pos >= 0 ? 'key' : '', style: { cursor: 'pointer' }, title: 'Click to use as key', on: { click: () => toggleKey(side, c.name) } }, pos >= 0 ? h('b', { style: { color: 'var(--accent-ink)', marginRight: '5px' } }, '①②③④⑤'[pos] || String(pos + 1)) : null, UI.typeChip(c.type), c.name);
      }))));
      tbl.appendChild(t);
      return tbl;
    };
    let pendingLeft = null;
    function toggleKey(side, name) {
      const i = k.on.findIndex((p) => p[side] === name);
      if (i >= 0) { k.on.splice(i, 1); }
      else if (side === 0) {
        const incomplete = k.on.findIndex((p) => !p[1]);
        if (incomplete >= 0) k.on[incomplete][0] = name;
        else k.on.push([name, rightSchema.some((c) => c.name === name) && !k.on.some((p) => p[1] === name) ? name : '']);
      } else {
        const incomplete = k.on.findIndex((p) => !p[1]);
        if (incomplete >= 0) k.on[incomplete][1] = name; else k.on.push(['', name]);
      }
      render();
    }
    async function loadRight() {
      const r = await UI.Engine.call('querySchema', { qid: rightSel.value });
      rightSchema = r.schema;
      k.right = rightSel.value;
      // auto-suggest matching key names when nothing is chosen yet
      if (!k.on.length) {
        const common = leftSchema.map((c) => c.name).filter((n) => rightSchema.some((c) => c.name === n));
        const idLike = common.find((n) => /(^|_| )(id|key|code)$/i.test(n)) || common[0];
        if (idLike) k.on = [[idLike, idLike]];
      }
      expand = null;
      render();
    }
    const refreshStats = PQ.debounce(async () => {
      UI.clear(stats);
      const valid = k.on.length && k.on.every((p) => p[0] && p[1]);
      if (how.value === 'cross') { stats.appendChild(h('div.faint', 'Every combination of rows.')); return; }
      if (!valid) { stats.appendChild(h('div.faint', 'Select key columns in both tables' + (k.on.length ? ': ' + k.on.map((p) => (p[0] || '?') + ' = ' + (p[1] || '?')).join(', ') : '.'))); return; }
      stats.appendChild(h('div.muted', h('span.spinner', { style: { display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' } }), 'Counting matches…'));
      try {
        const r = await UI.Engine.call('mergeStats', { qid: q.id, upto: idx - 1, right: k.right, on: k.on, how: how.value, castKeys: !!k.castKeys });
        UI.clear(stats);
        if (r.error) { stats.appendChild(h('div.callout.err', UI.icon('fa-circle-exclamation'), h('div', r.error))); return; }
        const s = r.stats;
        const pct = s.total ? Math.round((s.matched / s.total) * 100) : 0;
        stats.appendChild(h('div.callout.' + (pct >= 90 ? 'ok' : pct >= 50 ? 'info' : 'warn'), UI.icon(pct >= 90 ? 'fa-circle-check' : 'fa-circle-info'), h('div', h('b', 'The selection matches ' + PQ.fmtInt(s.matched) + ' of ' + PQ.fmtInt(s.total) + ' rows (' + pct + '%) from the first table'), ', and ' + PQ.fmtInt(s.rightMatched) + ' of ' + PQ.fmtInt(s.rightTotal) + ' rows from the second.', s.outRows !== undefined && how.value !== 'semi' && how.value !== 'anti' ? h('div.faint', 'Result: ' + PQ.fmtInt(s.outRows) + ' rows (preview sample).') : null)));
        s.warnings.forEach((w) => stats.appendChild(h('div.callout.warn', UI.icon('fa-triangle-exclamation'), h('div', w.text, w.fix === 'castKeys' ? h('div', { style: { marginTop: '4px' } }, h('button.btn.sm', { type: 'button', on: { click: () => { k.castKeys = true; refreshStats(); } } }, 'Compare keys as text')) : null))));
        if (k.castKeys) stats.appendChild(h('div.faint', { style: { fontSize: '11px' } }, 'Keys are compared as text. ', h('button.link-btn', { type: 'button', on: { click: () => { k.castKeys = false; refreshStats(); } } }, 'Undo')));
      } catch (e) { UI.clear(stats).appendChild(h('div.callout.err', UI.icon('fa-circle-exclamation'), h('div', e.message))); }
    }, 200);
    function render() {
      UI.clear(leftPick).append(h('div.field-label', q.name + ' (current, at step ' + idx + ')'), keyList(leftSchema, 0));
      UI.clear(rightPick).append(h('div.row', h('div.field-label.grow', 'Merge with'), rightSel), keyList(rightSchema, 1));
      const rightKeys = new Set(k.on.map((p) => p[1]));
      const expandable = rightSchema.filter((c) => !rightKeys.has(c.name));
      const m = W.colMulti(expandable, expand || expandable.map((c) => c.name), () => { expand = m.get(); });
      const hideExpand = how.value === 'semi' || how.value === 'anti';
      UI.clear(expandBox).appendChild(hideExpand ? h('div.muted', { style: { fontSize: '12px' } }, 'Semi/anti joins filter the first table and add no columns.') : W.field('Columns to bring in from ' + (others.find((x) => x.id === k.right) || {}).name, m));
      expandBox._get = () => (hideExpand ? [] : m.get());
      refreshStats();
    }
    rightSel.addEventListener('change', loadRight);
    how.addEventListener('change', render);
    const body = h('div.col', { style: { gap: '12px' } }, h('div.grid-2', leftPick, rightPick), W.field('Join kind', how), stats, h('div.grid-2', expandBox, W.field('Prefix', prefix)));
    UI.modal({
      title: 'Merge queries', icon: 'fa-code-merge', size: 'wide', body, okLabel: editing ? 'Apply' : 'Merge',
      onOk: () => {
        if (how.value !== 'cross' && (!k.on.length || !k.on.every((p) => p[0] && p[1]))) { UI.toast('Select keys on both sides', 'warn'); return false; }
        const kind = { type: 'Merge', right: k.right, on: how.value === 'cross' ? [] : k.on, how: how.value, expand: expandBox._get ? expandBox._get() : undefined, prefix: prefix.value.trim() || undefined, castKeys: k.castKeys || undefined };
        if (editing) Store.edit('Edit merge', (p) => { p.queries.find((x) => x.id === q.id).steps[o.index].kind = kind; });
        else Store.addStep(kind, { noFold: true });
      },
    });
    loadRight();
  };
})();
