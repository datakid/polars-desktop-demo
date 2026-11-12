(function () {
  const PQ = self.PQ, UI = PQ.UI, h = UI.h;

  UI.tip = function (el, text) {
    if (text) el.setAttribute('data-tip', text); else el.removeAttribute('data-tip');
    return el;
  };

  let selectSeq = 0;
  let openSelect = null;

  function normalize(o) {
    if (o && typeof o === 'object' && !Array.isArray(o)) return { value: String(o.value), label: String(o.label === undefined ? o.value : o.label), type: o.type || null, hint: o.hint || null };
    const [v, l] = Array.isArray(o) ? o : [o, o];
    return { value: String(v), label: String(l), type: null, hint: null };
  }

  UI.select = function (options, value, attrs) {
    const opts = options.map(normalize);
    const id = 'sel' + (++selectSeq);
    let index = opts.findIndex((o) => o.value === String(value));
    if (index < 0 && opts.length) index = 0;
    let list = null, scroller = null, search = null, rows = [], shown = [], active = -1, watch = 0, typed = '', typedAt = 0;
    const label = h('span.select-label');
    const root = h('button.select.input', Object.assign({ type: 'button', role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false' }, attrs || {}), label, UI.icon('fa-chevron-down', 'select-caret'));

    const fill = (node, o) => {
      if (o.type) node.appendChild(UI.typeChip(o.type));
      node.appendChild(h('span.select-text', o.label));
    };
    const render = () => {
      UI.clear(label);
      if (index >= 0) fill(label, opts[index]);
      root.classList.toggle('empty', index < 0 || !opts[index].label.trim());
    };
    Object.defineProperty(root, 'value', {
      configurable: true,
      get: () => (index >= 0 ? opts[index].value : ''),
      set: (v) => { index = opts.findIndex((o) => o.value === String(v)); render(); },
    });
    Object.defineProperty(root, 'selectedIndex', { configurable: true, get: () => index });
    root.options = opts;

    const commit = (i) => {
      if (i < 0 || i >= opts.length || i === index) return;
      index = i;
      render();
      root.dispatchEvent(new Event('input', { bubbles: true }));
      root.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const searchable = opts.length > 12;

    const setActive = (pos, scroll) => {
      if (!shown.length) { active = -1; return; }
      active = Math.max(0, Math.min(shown.length - 1, pos));
      rows.forEach((r, k) => { const on = k === active; r.el.classList.toggle('on', on); });
      const cur = rows[active];
      if (cur) {
        root.setAttribute('aria-activedescendant', cur.el.id);
        if (scroll !== false) cur.el.scrollIntoView({ block: 'nearest' });
      }
    };

    const place = () => {
      const r = root.getBoundingClientRect();
      const need = Math.min(list.scrollHeight, 340);
      const below = innerHeight - r.bottom - 10;
      const above = r.top - 10;
      const up = below < Math.min(need, 180) && above > below;
      const room = Math.max(120, Math.min(340, up ? above : below));
      list.style.minWidth = r.width + 'px';
      list.style.maxWidth = Math.max(r.width, Math.min(520, innerWidth - 16)) + 'px';
      scroller.style.maxHeight = (room - (search ? 46 : 0)) + 'px';
      const lh = list.getBoundingClientRect();
      let left = r.left;
      if (left + lh.width > innerWidth - 8) left = Math.max(8, innerWidth - lh.width - 8);
      list.style.left = left + 'px';
      list.style.top = (up ? Math.max(8, r.top - lh.height - 4) : r.bottom + 4) + 'px';
    };

    const draw = () => {
      const q = search ? search.value.trim().toLowerCase() : '';
      UI.clear(scroller);
      rows = []; shown = [];
      opts.forEach((o, i) => {
        if (q && !o.label.toLowerCase().includes(q)) return;
        const el = h('div.dd-i', { role: 'option', id: id + '-' + i, 'aria-selected': i === index ? 'true' : 'false', class: i === index ? 'sel' : '' },
          UI.icon('fa-check', 'dd-check'));
        fill(el, o);
        const k = shown.length;
        el.addEventListener('mousedown', (e) => e.preventDefault());
        el.addEventListener('mousemove', () => { if (active !== k) setActive(k, false); });
        el.addEventListener('click', () => { commit(i); close(); });
        shown.push(i); rows.push({ el, i });
        scroller.appendChild(el);
      });
      if (!shown.length) scroller.appendChild(h('div.dd-empty', 'No matches'));
      const sel = shown.indexOf(index);
      setActive(sel >= 0 ? sel : 0);
      if (list.isConnected) place();
    };

    const onKey = (e) => {
      if (!list) return;
      const k = e.key;
      if (k === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (k === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (k === 'PageDown') { e.preventDefault(); setActive(active + 8); }
      else if (k === 'PageUp') { e.preventDefault(); setActive(active - 8); }
      else if (k === 'Home' && !search) { e.preventDefault(); setActive(0); }
      else if (k === 'End' && !search) { e.preventDefault(); setActive(shown.length - 1); }
      else if (k === ' ' && !search && typed && Date.now() - typedAt < 700) { e.preventDefault(); typeahead(k, true); }
      else if (k === 'Enter' || (k === ' ' && !search)) { e.preventDefault(); e.stopPropagation(); if (active >= 0) commit(shown[active]); close(); }
      else if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (k === 'Tab') { close(false); }
      else if (!search && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeahead(k, true); }
    };

    const typeahead = (ch, inList) => {
      const now = Date.now();
      typed = now - typedAt > 700 ? ch.toLowerCase() : typed + ch.toLowerCase();
      typedAt = now;
      const start = inList ? Math.max(0, active) : Math.max(0, index);
      const order = (list ? shown : opts.map((_, i) => i));
      const from = typed.length === 1 ? start + 1 : start;
      for (let n = 0; n < order.length; n++) {
        const pos = (from + n) % order.length;
        if (opts[order[pos]].label.toLowerCase().replace(/^[^a-z0-9]+/, '').startsWith(typed)) {
          if (list) setActive(pos); else commit(order[pos]);
          return;
        }
      }
    };

    const onOutside = (e) => {
      if (!list) return;
      if (list.contains(e.target) || root.contains(e.target)) return;
      close(false);
    };
    const onScroll = (e) => { if (list && !list.contains(e.target)) close(false); };
    const onResize = () => close(false);

    function open() {
      if (list || root.disabled) return;
      if (openSelect) openSelect();
      UI.closeMenu();
      list = h('div.dd', { role: 'listbox', id: id + '-list', 'aria-label': root.getAttribute('aria-label') || null });
      scroller = h('div.dd-scroll');
      search = null;
      if (searchable) {
        search = h('input.input.sm.dd-search', { placeholder: 'Search…', 'aria-label': 'Search options', 'aria-controls': id + '-list' });
        search.addEventListener('input', () => { draw(); });
        search.addEventListener('keydown', onKey);
        list.appendChild(h('div.dd-search-wrap', UI.icon('fa-magnifying-glass'), search));
      }
      list.appendChild(scroller);
      document.body.appendChild(list);
      root.setAttribute('aria-expanded', 'true');
      root.setAttribute('aria-controls', id + '-list');
      draw();
      place();
      document.addEventListener('pointerdown', onOutside, true);
      addEventListener('scroll', onScroll, true);
      addEventListener('resize', onResize);
      watch = setInterval(() => { if (!root.isConnected) close(false); }, 200);
      openSelect = () => close(false);
      if (search) search.focus({ preventScroll: true });
    }
    function close(refocus) {
      if (!list) return;
      document.removeEventListener('pointerdown', onOutside, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', onResize);
      clearInterval(watch);
      list.remove();
      list = scroller = search = null;
      rows = []; shown = []; active = -1;
      openSelect = null;
      root.setAttribute('aria-expanded', 'false');
      root.removeAttribute('aria-activedescendant');
      if (refocus !== false && root.isConnected) root.focus({ preventScroll: true });
    }

    root.addEventListener('click', () => { if (list) close(); else open(); });
    root.addEventListener('keydown', (e) => {
      if (root.disabled) return;
      if (list) return onKey(e);
      const k = e.key;
      if (k === ' ' && typed && Date.now() - typedAt < 700) { e.preventDefault(); typeahead(k, false); }
      else if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); open(); }
      else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); typeahead(k, false); }
    });
    root.addEventListener('blur', () => { if (list && !(search && document.activeElement === search)) setTimeout(() => { if (list && document.activeElement !== search && document.activeElement !== root) close(false); }, 0); });

    render();
    return root;
  };

  UI.numberInput = function (value, attrs) {
    const a = Object.assign({}, attrs || {});
    const min = a.min !== undefined && a.min !== '' ? +a.min : null;
    const max = a.max !== undefined && a.max !== '' ? +a.max : null;
    const stepN = a.step === undefined || a.step === 'any' ? 1 : +a.step || 1;
    const style = a.style, cls = a.class;
    ['min', 'max', 'step', 'style', 'class'].forEach((k) => delete a[k]);
    const negative = min === null || min < 0;
    const input = h('input.input', Object.assign({ type: 'text', inputmode: negative ? 'text' : 'decimal', value: value === undefined || value === null ? '' : value }, a));
    const clean = (v) => {
      let s = v.replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
      const neg = negative && s.startsWith('-');
      s = s.replace(/-/g, '');
      const i = s.indexOf('.');
      if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '');
      return (neg ? '-' : '') + s;
    };
    input.addEventListener('input', () => {
      const v = input.value, s = clean(v);
      if (s === v) return;
      const pos = Math.max(0, (input.selectionStart || 0) - (v.length - s.length));
      input.value = s;
      try { input.setSelectionRange(pos, pos); } catch (e) { }
    });
    const bump = (dir) => {
      let n = parseFloat(input.value);
      if (isNaN(n)) n = min !== null ? min : 0;
      else n = Math.round((n + dir * stepN) * 1e10) / 1e10;
      if (min !== null) n = Math.max(min, n);
      if (max !== null) n = Math.min(max, n);
      input.value = String(n);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp') { e.preventDefault(); bump(1); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); bump(-1); }
    });
    const stepBtn = (dir, icon, name) => h('button.stepper-btn', { type: 'button', tabindex: '-1', 'aria-label': name, on: { pointerdown: (e) => e.preventDefault(), click: () => { if (!input.disabled) bump(dir); } } }, UI.icon(icon));
    const wrap = h('div.stepper', { style, class: cls }, input, h('div.stepper-steps', stepBtn(1, 'fa-chevron-up', 'Increase'), stepBtn(-1, 'fa-chevron-down', 'Decrease')));
    Object.defineProperty(wrap, 'value', { configurable: true, get: () => input.value, set: (v) => { input.value = v === null || v === undefined ? '' : String(v); } });
    Object.defineProperty(wrap, 'disabled', { configurable: true, get: () => input.disabled, set: (v) => { input.disabled = !!v; wrap.classList.toggle('disabled', !!v); } });
    wrap.input = input;
    wrap.focus = (o) => input.focus(o);
    wrap.select = () => input.select();
    return wrap;
  };

  const tipEl = h('div.tip', { role: 'tooltip' });
  let tipTarget = null, tipTimer = 0, tipSeen = 0, tipX = 0;

  const hideTip = () => {
    clearTimeout(tipTimer);
    if (tipTarget) tipSeen = Date.now();
    tipTarget = null;
    tipEl.classList.remove('on');
    if (tipEl.isConnected) tipEl.remove();
  };
  const showTip = (el, byKey) => {
    const text = el.getAttribute('data-tip');
    if (!text || !el.isConnected || document.body.classList.contains('reordering')) return;
    if (byKey ? !el.matches(':focus-visible') : !el.matches(':hover')) return;
    tipEl.textContent = text;
    document.body.appendChild(tipEl);
    const r = el.getBoundingClientRect();
    const w = tipEl.offsetWidth, hh = tipEl.offsetHeight;
    const anchor = !byKey && r.width > 260 ? tipX : r.left + r.width / 2;
    const left = Math.max(8, Math.min(innerWidth - w - 8, anchor - w / 2));
    let top = r.bottom + 8;
    if (top + hh > innerHeight - 8) top = Math.max(8, r.top - hh - 8);
    tipEl.style.left = left + 'px';
    tipEl.style.top = top + 'px';
    tipEl.classList.add('on');
  };
  const adopt = (el) => {
    if (el.hasAttribute('title')) {
      const t = el.getAttribute('title');
      el.removeAttribute('title');
      if (t) {
        el.setAttribute('data-tip', t);
        if (!el.hasAttribute('aria-label') && !el.textContent.trim() && /^(button|a)$/.test(el.localName)) el.setAttribute('aria-label', t);
      }
    }
  };
  const tipTargetOf = (node) => {
    const el = node && node.closest ? node.closest('[data-tip],[title]') : null;
    if (el) adopt(el);
    return el && el.getAttribute('data-tip') ? el : null;
  };
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    tipX = e.clientX;
    const el = tipTargetOf(e.target);
    if (el === tipTarget) return;
    hideTip();
    if (!el) return;
    tipTarget = el;
    tipTimer = setTimeout(() => showTip(el, false), Date.now() - tipSeen < 400 ? 0 : 450);
  }, true);
  document.addEventListener('pointermove', (e) => { tipX = e.clientX; }, true);
  document.addEventListener('pointerdown', hideTip, true);
  document.addEventListener('wheel', hideTip, { capture: true, passive: true });
  document.addEventListener('scroll', hideTip, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' || !['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key)) hideTip(); }, true);
  document.addEventListener('focusin', (e) => {
    const el = tipTargetOf(e.target);
    if (!el || !el.matches(':focus-visible')) return;
    hideTip();
    tipTarget = el;
    tipTimer = setTimeout(() => showTip(el, true), 350);
  });
  document.addEventListener('focusout', hideTip);
  addEventListener('blur', hideTip);

  const isTextField = (el) => el && ((el.localName === 'textarea') || (el.localName === 'input' && /^(text|search|url|email|tel|password|number)?$/.test(el.getAttribute('type') || '')));
  const textMenu = (field, x, y) => {
    const locked = field.readOnly || field.disabled;
    const s = field.selectionStart, e = field.selectionEnd;
    const has = s !== null && e !== null && e > s;
    const fire = () => field.dispatchEvent(new Event('input', { bubbles: true }));
    const copy = () => PQ.Platform.copyText(field.value.slice(field.selectionStart, field.selectionEnd));
    UI.menu([
      { label: 'Cut', icon: 'fa-scissors', kbd: 'Ctrl+X', disabled: locked || !has, run: async () => { if (await copy()) { field.focus(); field.setRangeText('', s, e, 'end'); fire(); } } },
      { label: 'Copy', icon: 'fa-copy', kbd: 'Ctrl+C', disabled: !has, run: async () => { await copy(); field.focus(); } },
      { label: 'Paste', icon: 'fa-paste', kbd: 'Ctrl+V', disabled: locked, run: async () => {
        let text = '';
        try { text = await navigator.clipboard.readText(); } catch (err) { UI.toast('Clipboard access is blocked. Press ' + PQ.Platform.kbd('Ctrl+V') + ' to paste.', 'warn'); return; }
        field.focus();
        field.setRangeText(text, s === null ? field.value.length : s, e === null ? field.value.length : e, 'end');
        fire();
      } },
      '-',
      { label: 'Select all', icon: 'fa-i-cursor', kbd: 'Ctrl+A', run: () => { field.focus(); field.select(); } },
    ], x, y);
  };
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const field = e.target.closest ? e.target.closest('input, textarea') : null;
    e.preventDefault();
    if (isTextField(field)) return textMenu(field, e.clientX, e.clientY);
    const text = String(getSelection() || '');
    if (text) UI.menu([{ label: 'Copy', icon: 'fa-copy', kbd: 'Ctrl+C', run: () => UI.copy(text, false) }], e.clientX, e.clientY);
  });

  const GRIP = 16;
  const inGrip = (ta, e) => { const r = ta.getBoundingClientRect(); return e.clientX >= r.right - GRIP && e.clientY >= r.bottom - GRIP && e.clientX <= r.right && e.clientY <= r.bottom; };
  document.addEventListener('pointermove', (e) => {
    const ta = e.target;
    if (ta && ta.localName === 'textarea') ta.classList.toggle('grip-hot', inGrip(ta, e));
  }, true);
  document.addEventListener('pointerdown', (e) => {
    const ta = e.target;
    if (e.button !== 0 || !ta || ta.localName !== 'textarea' || !inGrip(ta, e)) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = ta.offsetHeight;
    const min = parseFloat(getComputedStyle(ta).minHeight) || 38;
    try { ta.setPointerCapture(e.pointerId); } catch (err) { }
    const move = (ev) => { ta.style.height = Math.max(min, h0 + ev.clientY - y0) + 'px'; };
    const up = () => { ta.removeEventListener('pointermove', move); ta.removeEventListener('pointerup', up); ta.removeEventListener('pointercancel', up); };
    ta.addEventListener('pointermove', move); ta.addEventListener('pointerup', up); ta.addEventListener('pointercancel', up);
  }, true);
})();
