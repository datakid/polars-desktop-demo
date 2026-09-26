/* Formula editor: syntax highlighting, schema-aware validation with positioned error underline,
 * autocomplete for [columns], Functions and @parameters. (Monaco in the Tauri build.) */
(function () {
  const PQ = self.PQ, UI = PQ.UI, h = UI.h;

  /** UI.formulaEditor({value, schema, params, single, placeholder, onChange(value, validation)}) → {el, get, set, focus, validation} */
  UI.formulaEditor = function (o) {
    const pre = h('pre', { 'aria-hidden': 'true' });
    const ta = h('textarea', { spellcheck: 'false', autocomplete: 'off', placeholder: o.placeholder || '', rows: o.single ? 1 : 3, 'aria-label': o.label || 'Formula' });
    ta.value = o.value || '';
    const box = h('div.fx-editor' + (o.single ? '.single' : ''), pre, ta);
    const status = h('div.fx-status');
    const help = h('div.fx-help');
    const el = h('div', box, status, o.noHelp ? null : help);
    let ac = null, acItems = [], acIdx = 0, acRange = null, validation = null;

    const quickFns = o.quick || ['if … then … else', 'Text.Upper', 'Text.Contains', 'Date.Year', 'Number.Round', 'Coalesce'];
    if (!o.noHelp) quickFns.forEach((fn) => help.appendChild(h('button', { type: 'button', on: { click: () => insert(fn === 'if … then … else' ? 'if  then  else ' : fn + '()', fn === 'if … then … else' ? 3 : fn.length + 1) } }, fn)));
    if (!o.noHelp) help.appendChild(h('span.faint', { style: { fontSize: '11px', alignSelf: 'center', marginLeft: '4px' } }, 'Ctrl+Space for suggestions'));

    function render() {
      const src = ta.value;
      const toks = PQ.Formula.highlight(src);
      UI.clear(pre);
      let pos = 0;
      const es = validation && !validation.ok ? validation.start : -1, ee = validation && !validation.ok ? Math.max(validation.end, validation.start + 1) : -1;
      toks.forEach((t) => {
        const a = pos, b = pos + t.text.length; pos = b;
        if (es >= 0 && b > es && a < ee) {
          // split token around the error span
          const i1 = Math.max(0, es - a), i2 = Math.min(t.text.length, ee - a);
          if (i1 > 0) pre.appendChild(h('span', { class: t.cls || '' }, t.text.slice(0, i1)));
          pre.appendChild(h('span', { class: (t.cls || '') + ' errspan' }, t.text.slice(i1, i2)));
          if (i2 < t.text.length) pre.appendChild(h('span', { class: t.cls || '' }, t.text.slice(i2)));
        } else pre.appendChild(t.cls ? h('span', { class: t.cls }, t.text) : document.createTextNode(t.text));
      });
      if (es >= src.length) pre.appendChild(h('span.errspan', ' '));
      pre.appendChild(document.createTextNode('\n'));
      pre.scrollTop = ta.scrollTop;
    }
    function validate() {
      validation = PQ.Formula.validate(ta.value, o.schema || [], o.params || []);
      box.classList.toggle('invalid', !validation.ok && !!ta.value.trim());
      UI.clear(status);
      if (!ta.value.trim()) { status.className = 'fx-status'; status.appendChild(h('span.faint', o.emptyText || 'Type a formula — e.g. [Quantity] * [Unit Price]')); }
      else if (validation.ok) { status.className = 'fx-status ok'; status.append(UI.icon('fa-check'), ' Valid · returns ', h('b', PQ.TYPES[validation.type] ? PQ.TYPES[validation.type].label : validation.type)); }
      else { status.className = 'fx-status err'; status.append(UI.icon('fa-circle-exclamation'), ' ', validation.message, validation.hint ? h('span.hint', ' — ' + validation.hint) : null); }
      render();
      return validation;
    }
    const changed = () => { validate(); o.onChange && o.onChange(ta.value, validation); };

    function insert(text, caretOffset) {
      const s = ta.selectionStart, e = ta.selectionEnd;
      ta.setRangeText(text, s, e, 'end');
      if (caretOffset !== undefined) ta.selectionStart = ta.selectionEnd = s + caretOffset;
      ta.focus(); changed();
    }

    /* ---------- autocomplete ---------- */
    function context() {
      const pos = ta.selectionStart, before = ta.value.slice(0, pos);
      let m = /\[([^\]]*)$/.exec(before);
      if (m) return { kind: 'col', prefix: m[1], start: pos - m[1].length - 1 };
      m = /@([A-Za-z0-9_]*)$/.exec(before);
      if (m) return { kind: 'param', prefix: m[1], start: pos - m[0].length };
      m = /(#?[A-Za-z_][A-Za-z0-9_.]*)$/.exec(before);
      if (m) return { kind: 'fn', prefix: m[1], start: pos - m[1].length };
      return null;
    }
    function openAC(force) {
      const ctx = context();
      if (!ctx || (!force && ctx.kind === 'fn' && ctx.prefix.length < 2)) return closeAC();
      const p = ctx.prefix.toLowerCase();
      let items = [];
      if (ctx.kind === 'col') items = (o.schema || []).filter((c) => c.name.toLowerCase().includes(p)).map((c) => ({ label: c.name, kind: UI.typeIcon(c.type), doc: PQ.TYPES[c.type].label, insert: PQ.Formula.quoteCol(c.name) }));
      else if (ctx.kind === 'param') items = (o.params || []).filter((x) => x.name.toLowerCase().startsWith(p)).map((x) => ({ label: '@' + x.name, kind: 'PAR', doc: x.type + ' = ' + x.value, insert: '@' + x.name }));
      else {
        const kws = ['if', 'then', 'else', 'and', 'or', 'not', 'try', 'otherwise', 'null', 'true', 'false', 'in'];
        items = Object.values(PQ.FUNCS).filter((f) => f.name.toLowerCase().includes(p)).sort((a, b) => (a.name.toLowerCase().startsWith(p) ? 0 : 1) - (b.name.toLowerCase().startsWith(p) ? 0 : 1) || a.name.localeCompare(b.name))
          .map((f) => ({ label: f.name + '(' + f.sig.map((s) => ({ t: 'text', n: 'number', d: 'date', a: 'any', L: 'list' }[s[0]] + (s.endsWith('?') ? '?' : s.endsWith('...') ? '…' : ''))).join(', ') + ')', kind: 'fx', doc: f.doc, insert: f.name + '(', fn: true }))
          .concat(kws.filter((k) => k.startsWith(p) && k !== p).map((k) => ({ label: k, kind: 'kw', doc: 'keyword', insert: k + ' ' })))
          .concat((o.schema || []).filter((c) => c.name.toLowerCase().startsWith(p)).map((c) => ({ label: '[' + c.name + ']', kind: UI.typeIcon(c.type), doc: 'column', insert: PQ.Formula.quoteCol(c.name) })));
      }
      if (!items.length) return closeAC();
      acItems = items.slice(0, 60); acIdx = 0; acRange = ctx;
      if (!ac) { ac = h('div.ac', { role: 'listbox' }); document.body.appendChild(ac); }
      UI.clear(ac);
      acItems.forEach((it, i) => ac.appendChild(h('div.ac-i', { class: i === acIdx ? 'on' : '', role: 'option', on: { mousedown: (e) => { e.preventDefault(); acIdx = i; accept(); } } }, h('span.k', it.kind), h('span.nm', it.label), h('span.doc', it.doc))));
      const r = ta.getBoundingClientRect();
      ac.style.left = Math.min(r.left, innerWidth - 390) + 'px';
      ac.style.top = (r.bottom + 4 + 260 > innerHeight ? r.top - 264 : r.bottom + 4) + 'px';
    }
    function closeAC() { if (ac) { ac.remove(); ac = null; } }
    function accept() {
      const it = acItems[acIdx]; if (!it) return;
      const end = ta.selectionStart;
      let stop = end;
      if (acRange.kind === 'col') { const rest = ta.value.slice(end); const m = /^[^\]\n]*\]/.exec(rest); if (m) stop = end + m[0].length; }
      ta.setRangeText(it.insert, acRange.start, stop, 'end');
      closeAC(); ta.focus(); changed();
    }
    function moveAC(d) { acIdx = (acIdx + d + acItems.length) % acItems.length; [...ac.children].forEach((c, i) => c.classList.toggle('on', i === acIdx)); ac.children[acIdx].scrollIntoView({ block: 'nearest' }); }

    ta.addEventListener('input', () => { changed(); openAC(false); });
    ta.addEventListener('scroll', () => { pre.scrollTop = ta.scrollTop; });
    ta.addEventListener('blur', () => setTimeout(closeAC, 120));
    ta.addEventListener('keydown', (e) => {
      if (ac) {
        if (e.key === 'ArrowDown') { e.preventDefault(); return moveAC(1); }
        if (e.key === 'ArrowUp') { e.preventDefault(); return moveAC(-1); }
        if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); return accept(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closeAC(); }
      }
      if (e.key === ' ' && e.ctrlKey) { e.preventDefault(); openAC(true); }
      if (e.key === 'Enter' && o.single && !e.shiftKey && !e.ctrlKey && !e.metaKey) { e.preventDefault(); o.onEnter && o.onEnter(); }
      if (e.key === '[' && !ac) setTimeout(() => { if (ta.value[ta.selectionStart] !== ']') { ta.setRangeText(']', ta.selectionStart, ta.selectionStart, 'start'); } openAC(true); }, 0);
    });
    validate();
    return {
      el, textarea: ta,
      get: () => ta.value,
      set: (v) => { ta.value = v; changed(); },
      setSchema: (s) => { o.schema = s; validate(); },
      focus: () => { ta.focus(); ta.selectionStart = ta.selectionEnd = ta.value.length; },
      validation: () => validation,
      insert,
    };
  };
})();
