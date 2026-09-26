/* Virtualized data grid. Requests pages of rows (offset, count) from the engine on demand —
 * the whole result never crosses the process boundary. Column header shows type icon + quality strip. */
(function () {
  const PQ = self.PQ, UI = PQ.UI, h = UI.h;
  const ROW_H = 26, PAGE = 200, RN_W = 56;

  class Grid {
    constructor(el, opts) {
      this.el = el; this.opts = opts || {};
      this.result = null; this.pages = new Map(); this.loading = new Set();
      this.widths = new Map(); this.sel = new Set(); this.focus = null;
      this.inner = h('div.g-inner');
      this.head = h('div.g-head');
      this.body = h('div.g-body');
      this.inner.append(this.head, this.body);
      el.appendChild(this.inner);
      el.tabIndex = 0;
      el.addEventListener('scroll', () => this.paint());
      el.addEventListener('keydown', (e) => this.keys(e));
      new ResizeObserver(() => this.paint()).observe(el);
      this.body.addEventListener('mousedown', (e) => {
        const td = e.target.closest('.g-td'); if (!td) return;
        this.focus = { r: +td.dataset.r, c: +td.dataset.c }; this.el.focus(); this.paint();
      });
      this.body.addEventListener('contextmenu', (e) => {
        const td = e.target.closest('.g-td'); if (!td) return;
        e.preventDefault();
        this.focus = { r: +td.dataset.r, c: +td.dataset.c }; this.paint();
        const col = this.result.schema[this.focus.c];
        const v = this.value(this.focus.r, this.focus.c);
        this.opts.onCellMenu && this.opts.onCellMenu(col, v, e.clientX, e.clientY);
      });
    }
    setResult(res, keepScroll) {
      const sameShape = this.result && res && this.result.schema.map((c) => c.name).join('|') === res.schema.map((c) => c.name).join('|');
      this.result = res;
      this.pages = new Map(); this.loading = new Set();
      if (res && res.firstPage) this.pages.set(0, res.firstPage);
      if (!sameShape) { this.sel = new Set([...this.sel].filter((n) => res && res.schema.some((c) => c.name === n))); }
      if (!keepScroll && !sameShape) { this.el.scrollTop = 0; this.el.scrollLeft = 0; this.focus = null; }
      this.renderHead();
      this.paint();
    }
    width(name, type) {
      if (this.widths.has(name)) return this.widths.get(name);
      const base = Math.max(90, Math.min(260, name.length * 7.5 + 70));
      return type === 'bool' ? Math.max(base, 90) : type === 'date' ? Math.max(base, 110) : type === 'datetime' ? Math.max(base, 160) : base;
    }
    totalWidth() { return RN_W + (this.result ? this.result.schema.reduce((s, c) => s + this.width(c.name, c.type), 0) : 0); }
    setSelection(names) { this.sel = new Set(names); this.renderHead(); this.paint(); }

    renderHead() {
      UI.clear(this.head);
      if (!this.result) return;
      const r = this.result;
      this.head.style.width = this.totalWidth() + 'px';
      this.head.appendChild(h('div.g-rownum-h', { style: { width: RN_W + 'px', flex: 'none' } }));
      r.schema.forEach((c, i) => {
        const q = r.quality ? r.quality[i] : null;
        const n = r.n || 1;
        const pct = (x) => (x / n) * 100;
        const th = h('div.g-th', { class: this.sel.has(c.name) ? 'sel' : '', style: { width: this.width(c.name, c.type) + 'px' }, title: c.name + ' · ' + PQ.TYPES[c.type].label, role: 'columnheader', tabindex: -1 },
          h('div.th-top',
            UI.typeChip(c.type, { class: c.type === 'any' ? 'any' : '', title: 'Change type (' + PQ.TYPES[c.type].label + ')', on: { click: (e) => { e.stopPropagation(); this.opts.onTypeMenu && this.opts.onTypeMenu(c, e.currentTarget); } } }),
            h('span.th-name', c.name),
            this.opts.filtered && this.opts.filtered(c.name) ? UI.icon('fa-filter', 'th-filter') : null,
            h('button.th-menu', { 'aria-label': 'Column menu for ' + c.name, on: { click: (e) => { e.stopPropagation(); if (!this.sel.has(c.name)) { this.sel = new Set([c.name]); this.renderHead(); this.opts.onSelect && this.opts.onSelect([...this.sel]); } this.opts.onColMenu && this.opts.onColMenu(c, e.currentTarget); } } }, UI.icon('fa-caret-down'))),
          q ? h('div.quality', { title: 'Valid ' + PQ.fmtInt(q.valid) + ' · Error ' + PQ.fmtInt(q.error) + ' · Empty ' + PQ.fmtInt(q.empty) }, h('span.qv', { style: { width: pct(q.valid) + '%' } }), h('span.qe', { style: { width: pct(q.error) + '%' } }), h('span.qn', { style: { width: pct(q.empty) + '%' } })) : null,
          q ? h('div.quality-txt', h('span', Math.round(pct(q.valid)) + '% valid'), q.error ? h('span.e', PQ.fmtInt(q.error) + ' err') : null, q.empty ? h('span', Math.round(pct(q.empty)) + '% empty') : null) : null,
          h('div.resize', { on: { mousedown: (e) => this.startResize(e, c) , dblclick: (e) => { e.stopPropagation(); this.autoFit(c, i); } } }));
        th.addEventListener('click', (e) => {
          if (e.shiftKey && this.sel.size) {
            const names = r.schema.map((x) => x.name), last = [...this.sel].pop();
            const a = names.indexOf(last), b = i;
            for (let k = Math.min(a, b); k <= Math.max(a, b); k++) this.sel.add(names[k]);
          } else if (e.ctrlKey || e.metaKey) { if (this.sel.has(c.name)) this.sel.delete(c.name); else this.sel.add(c.name); }
          else this.sel = new Set([c.name]);
          this.renderHead(); this.paint();
          this.opts.onSelect && this.opts.onSelect([...this.sel]);
        });
        th.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          if (!this.sel.has(c.name)) { this.sel = new Set([c.name]); this.renderHead(); this.paint(); this.opts.onSelect && this.opts.onSelect([...this.sel]); }
          this.opts.onColMenu && this.opts.onColMenu(c, { getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY, right: e.clientX }) });
        });
        this.head.appendChild(th);
      });
    }
    startResize(e, c) {
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, w0 = this.width(c.name, c.type);
      const move = (ev) => { this.widths.set(c.name, Math.max(50, w0 + ev.clientX - x0)); this.renderHead(); this.paint(true); };
      const up = () => { removeEventListener('mousemove', move); removeEventListener('mouseup', up); };
      addEventListener('mousemove', move); addEventListener('mouseup', up);
    }
    autoFit(c, i) {
      const page = this.pages.get(0) || [];
      let w = c.name.length * 7.5 + 70;
      page.slice(0, 200).forEach((row) => { const t = UI.cellText(row[i], c.type).text; w = Math.max(w, t.length * 7 + 20); });
      this.widths.set(c.name, Math.min(600, w)); this.renderHead(); this.paint(true);
    }
    value(r, c) {
      const p = this.pages.get(Math.floor(r / PAGE));
      return p ? p[r % PAGE][c] : undefined;
    }
    async fetchPage(pi) {
      if (this.pages.has(pi) || this.loading.has(pi) || !this.result) return;
      const res = this.result;
      this.loading.add(pi);
      try {
        const { rows } = await UI.Engine.call('page', { resultId: res.resultId, offset: pi * PAGE, count: PAGE });
        if (this.result !== res) return;
        this.pages.set(pi, rows);
        if (this.pages.size > 60) { const k = this.pages.keys().next().value; if (k !== 0) this.pages.delete(k); }
        this.paint(true);
      } catch (e) { /* result expired: re-evaluated soon */ }
      finally { this.loading.delete(pi); }
    }
    paint() {
      const r = this.result;
      if (!r) { UI.clear(this.body); return; }
      const total = r.n;
      const tw = this.totalWidth();
      this.body.style.height = total * ROW_H + 'px';
      this.body.style.width = tw + 'px';
      this.inner.style.width = tw + 'px';
      const headH = this.head.offsetHeight;
      const top = Math.max(0, this.el.scrollTop - headH);
      const vh = this.el.clientHeight;
      const r0 = Math.max(0, Math.floor(top / ROW_H) - 5), r1 = Math.min(total, Math.ceil((top + vh) / ROW_H) + 5);
      // horizontal virtualization
      const left = this.el.scrollLeft, vw = this.el.clientWidth;
      const xs = []; let x = RN_W;
      r.schema.forEach((c) => { const w = this.width(c.name, c.type); xs.push([x, w]); x += w; });
      let c0 = 0; while (c0 < xs.length && xs[c0][0] + xs[c0][1] < left) c0++;
      let c1 = c0; while (c1 < xs.length && xs[c1][0] < left + vw) c1++;
      for (let p = Math.floor(r0 / PAGE); p <= Math.floor(Math.max(r0, r1 - 1) / PAGE); p++) this.fetchPage(p);
      const frag = document.createDocumentFragment();
      for (let row = r0; row < r1; row++) {
        const rowEl = h('div.g-row', { style: { top: row * ROW_H + 'px', width: tw + 'px' } });
        rowEl.appendChild(h('div.g-rownum', String(row + 1)));
        if (c0 > 0) rowEl.appendChild(h('div', { style: { width: xs[c0][0] - RN_W + 'px', flex: 'none' } }));
        const page = this.pages.get(Math.floor(row / PAGE));
        for (let c = c0; c < c1; c++) {
          const col = r.schema[c];
          let text, cls = '', title;
          if (!page) { text = '···'; cls = 'loading'; }
          else { const ct = UI.cellText(page[row % PAGE][c], col.type); text = ct.text; cls = ct.cls; title = ct.title; }
          const td = h('div.g-td', { style: { width: xs[c][1] + 'px' }, class: cls + (this.sel.has(col.name) ? ' sel' : '') + (this.focus && this.focus.r === row && this.focus.c === c ? ' focus' : ''), title: title || (text && text.length > 18 ? text : null), dataset: { r: row, c } }, text);
          rowEl.appendChild(td);
        }
        frag.appendChild(rowEl);
      }
      UI.clear(this.body).appendChild(frag);
    }
    keys(e) {
      if (!this.result || !this.focus) return;
      const { r, c } = this.focus;
      const mv = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageDown: [20, 0], PageUp: [-20, 0] }[e.key];
      if (mv) {
        e.preventDefault();
        this.focus = { r: Math.max(0, Math.min(this.result.n - 1, r + mv[0])), c: Math.max(0, Math.min(this.result.schema.length - 1, c + mv[1])) };
        const y = this.focus.r * ROW_H + this.head.offsetHeight;
        if (y < this.el.scrollTop + this.head.offsetHeight) this.el.scrollTop = y - this.head.offsetHeight;
        else if (y + ROW_H > this.el.scrollTop + this.el.clientHeight) this.el.scrollTop = y + ROW_H - this.el.clientHeight;
        this.paint();
      } else if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        const v = this.value(r, c);
        navigator.clipboard && navigator.clipboard.writeText(UI.cellText(v, this.result.schema[c].type).text);
        UI.toast('Copied', 'ok', { ms: 1000 });
      }
    }
  }
  UI.Grid = Grid;
})();
