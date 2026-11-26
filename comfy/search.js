/* SeaGraph node search popup — workstream B.
 * SG.Search.open({registry, x, y, filterType?, filterDir?, types?, container?, title?, onPick(type), onClose?})
 *   x, y: client coordinates for the popup's top-left corner.
 *   filterType + filterDir "in" (default): only node types with an INPUT that accepts filterType.
 *   filterType + filterDir "out": only node types with an OUTPUT compatible with an input of filterType.
 * Returns {close(), el, input}. Only one popup is open at a time.
 */
(function (root) {
  const SG = root.SeaGraph = root.SeaGraph || {};
  let current = null;
  let seq = 0;

  function compat(types, a, b) {
    if (types && typeof types.compatible === "function") {
      try { return !!types.compatible(a, b); } catch (e) { return false; }
    }
    return a === b || a === "*" || b === "*";
  }

  function accepts(def, filterType, filterDir, types) {
    if (!filterType) return true;
    if (filterDir === "out") {
      return (def.outputs || []).some(function (o) { return compat(types, o.type, filterType); });
    }
    const ins = (def.inputs || []).some(function (i) { return compat(types, filterType, i.type); });
    if (ins) return true;
    return (def.widgets || []).some(function (w) { return w.convertible && w.type && compat(types, filterType, w.type); });
  }

  function hay(def) {
    return [def.title, def.type, def.category, def.hint].filter(Boolean).join(" ").toLowerCase();
  }

  function rank(defs, q) {
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored = [];
    defs.forEach(function (d) {
      const h = hay(d);
      if (!tokens.every(function (t) { return h.indexOf(t) >= 0; })) return;
      const title = String(d.title || d.type).toLowerCase();
      let score = 3;
      if (tokens.length && title.indexOf(tokens[0]) === 0) score = 0;
      else if (tokens.length && title.indexOf(tokens[0]) >= 0) score = 1;
      else if (tokens.length && String(d.type).toLowerCase().indexOf(tokens[0]) >= 0) score = 2;
      scored.push({ d: d, score: tokens.length ? score : 0 });
    });
    scored.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;
      const ca = String(a.d.category || ""), cb = String(b.d.category || "");
      if (ca !== cb) return ca.localeCompare(cb, "zh-Hant");
      return String(a.d.title || a.d.type).localeCompare(String(b.d.title || b.d.type), "zh-Hant");
    });
    return scored.map(function (x) { return x.d; });
  }

  function match(opts, q) {
    const reg = opts.registry || SG.registry;
    let defs = [];
    try { defs = (reg && typeof reg.list === "function" ? reg.list() : []) || []; } catch (e) { defs = []; }
    defs = defs.filter(function (d) { return d && !d.hidden && accepts(d, opts.filterType, opts.filterDir, opts.types || SG.types); });
    return rank(defs, q || "");
  }

  function open(opts) {
    opts = opts || {};
    if (current) current.close();
    const doc = (opts.container && opts.container.ownerDocument) || root.document;
    const win = doc.defaultView || root;
    const container = opts.container || doc.body;
    const id = "sg-search-" + (++seq);
    function mk(tag, cls, attrs, text) {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    }
    const title = opts.title || "搜尋節點";
    const pop = mk("div", "sg-pop sg-search", { role: "dialog", "aria-label": title });
    const head = mk("div", "sg-search-title", { id: id + "-t" }, title);
    const input = mk("input", "sg-search-input", {
      type: "text", role: "combobox", "aria-expanded": "true", "aria-autocomplete": "list",
      "aria-controls": id + "-list", "aria-labelledby": id + "-t", placeholder: "輸入名稱、分類或類型…",
      autocomplete: "off", spellcheck: "false"
    });
    const list = mk("ul", "sg-search-list", { role: "listbox", id: id + "-list", "aria-label": "節點類型" });
    const empty = mk("div", "sg-search-empty", { role: "status" }, "找不到符合的節點。");
    const foot = mk("div", "sg-search-foot", { "aria-hidden": "true" }, "↑↓ 選擇 · Enter 加入 · Esc 關閉");
    pop.append(head, input, list, empty, foot);

    let items = [];
    let active = 0;
    let closed = false;

    function setActive(i, scroll) {
      if (!items.length) { input.removeAttribute("aria-activedescendant"); return; }
      active = (i + items.length) % items.length;
      const lis = list.children;
      for (let k = 0; k < lis.length; k++) lis[k].setAttribute("aria-selected", k === active ? "true" : "false");
      const li = lis[active];
      if (li) {
        input.setAttribute("aria-activedescendant", li.id);
        if (scroll !== false && li.scrollIntoView) li.scrollIntoView({ block: "nearest" });
      }
    }
    function renderList() {
      items = match(opts, input.value).slice(0, 80);
      list.replaceChildren();
      items.forEach(function (d, i) {
        const li = mk("li", "sg-search-item", { role: "option", id: id + "-o" + i, "aria-selected": "false" });
        const t = mk("span", "sg-search-name", null, d.title || d.type);
        const meta = mk("span", "sg-search-meta", null, [d.category, d.hint].filter(Boolean).join(" · ") || d.type);
        li.append(t, meta);
        li.addEventListener("pointerdown", function (e) { e.preventDefault(); });
        li.addEventListener("pointermove", function () { if (active !== i) setActive(i, false); });
        li.addEventListener("click", function () { pick(i); });
        list.append(li);
      });
      empty.hidden = items.length > 0;
      list.hidden = !items.length;
      setActive(0);
    }
    function pick(i) {
      const d = items[i];
      if (!d) return;
      close(true);
      if (opts.onPick) opts.onPick(d.type);
    }
    function onKey(e) {
      const k = e.key;
      if (k === "ArrowDown") { e.preventDefault(); setActive(active + 1); }
      else if (k === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (k === "PageDown") { e.preventDefault(); setActive(Math.min(items.length - 1, active + 8)); }
      else if (k === "PageUp") { e.preventDefault(); setActive(Math.max(0, active - 8)); }
      else if (k === "Enter") { e.preventDefault(); pick(active); }
      else if (k === "Escape" || k === "Tab") { e.preventDefault(); close(false); }
      e.stopPropagation();
    }
    function onOutside(e) { if (!pop.contains(e.target)) close(false); }
    function close(picked) {
      if (closed) return;
      closed = true;
      doc.removeEventListener("pointerdown", onOutside, true);
      pop.remove();
      if (current === api) current = null;
      if (opts.onClose) { try { opts.onClose(!!picked); } catch (e) { /* ignore */ } }
    }

    input.addEventListener("input", renderList);
    input.addEventListener("keydown", onKey);
    pop.addEventListener("keydown", function (e) { e.stopPropagation(); });
    pop.addEventListener("wheel", function (e) { e.stopPropagation(); }, { passive: true });
    pop.addEventListener("contextmenu", function (e) { e.stopPropagation(); });

    const x = Number(opts.x) || 0, y = Number(opts.y) || 0;
    pop.style.left = x + "px";
    pop.style.top = y + "px";
    container.append(pop);
    renderList();
    const W = win.innerWidth || 1024, H = win.innerHeight || 768;
    pop.style.left = Math.max(4, Math.min(x, W - pop.offsetWidth - 4)) + "px";
    pop.style.top = Math.max(4, Math.min(y, H - pop.offsetHeight - 4)) + "px";
    doc.addEventListener("pointerdown", onOutside, true);
    input.focus({ preventScroll: true });

    const api = { close: function () { close(false); }, el: pop, input: input };
    current = api;
    return api;
  }

  SG.Search = {
    open: open,
    close: function () { if (current) current.close(); },
    match: function (opts, q) { return match(opts || {}, q || ""); }
  };
})(globalThis);
