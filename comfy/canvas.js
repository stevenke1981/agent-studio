/* SeaGraph DOM canvas — workstream B.
 * Classic script, no dependencies, works over file://.
 * DOM nodes + SVG wires inside a CSS-transformed world layer.
 * Contract: docs/comfy-plan.md ("B: canvas") + Amendment 1 (waiting / approval).
 */
(function (root) {
  const SG = root.SeaGraph = root.SeaGraph || {};

  const MIME = "application/x-sea-node";
  const SVGNS = "http://www.w3.org/2000/svg";
  const MIN_K = 0.25;
  const MAX_K = 2.5;
  const NODE_W = 220;
  const GRID = 20;
  const MINIMAP_KEY = "sea-agent-studio-v06.ui.minimap"; // "1" / "0"; absent = auto by host width
  const MINIMAP_MIN_W = 700;                             // auto mode hides the minimap below this host width
  const GROUP_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#a855f7", "#ef4444", "#14b8a6"];
  const DEFAULT_LABELS = {
    canvas: "節點畫布",
    nodeSuffix: "節點",
    input: "輸入",
    output: "輸出",
    missing: "缺少節點類型",
    emptyTitle: "畫布是空的",
    empty: "雙擊空白處或按下方按鈕搜尋節點",
    emptyReadOnly: "這個流程目前沒有任何節點。",
    emptyAction: "搜尋節點",
    controls: "畫布檢視控制",
    menu: "節點選單",
    preview: "預覽",
    group: "群組"
  };
  const STATUS_TEXT = {
    queued: "等待中", running: "執行中", waiting: "等待核准", done: "完成",
    cached: "快取", error: "錯誤", skipped: "已略過"
  };
  const MODE_TEXT = { bypass: "略過", mute: "停用" };
  const STATUSES = ["queued", "running", "waiting", "done", "cached", "error", "skipped"];

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function isEditable(t) {
    if (!t || t.nodeType !== 1) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function bez(a, b) {
    const dx = Math.max(30, Math.abs(b.x - a.x) * 0.5);
    return "M" + r1(a.x) + "," + r1(a.y) + " C" + r1(a.x + dx) + "," + r1(a.y) + " " +
      r1(b.x - dx) + "," + r1(b.y) + " " + r1(b.x) + "," + r1(b.y);
  }
  // Polyline with rounded corners (quadratic joins), used for backward wires.
  function roundedPath(pts, R) {
    let d = "M" + r1(pts[0].x) + "," + r1(pts[0].y);
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p = pts[i], p1 = pts[i + 1];
      const l0 = Math.hypot(p.x - p0.x, p.y - p0.y), l1 = Math.hypot(p1.x - p.x, p1.y - p.y);
      const r = Math.min(R, l0 / 2, l1 / 2);
      if (r < 0.5) { d += " L" + r1(p.x) + "," + r1(p.y); continue; }
      const ax = p.x + (p0.x - p.x) / l0 * r, ay = p.y + (p0.y - p.y) / l0 * r;
      const bx = p.x + (p1.x - p.x) / l1 * r, by = p.y + (p1.y - p.y) / l1 * r;
      d += " L" + r1(ax) + "," + r1(ay) + " Q" + r1(p.x) + "," + r1(p.y) + " " + r1(bx) + "," + r1(by);
    }
    const last = pts[pts.length - 1];
    return d + " L" + r1(last.x) + "," + r1(last.y);
  }
  // Backward link (target left of source): exit right, run through the gap between the two
  // node rows (or below both when they share a row), enter the target from the left.
  // sa / sb are the source / target node boxes {x,y,w,h} in world units.
  function backRoute(a, b, sa, sb) {
    const o = clamp(Math.hypot(a.x - b.x, a.y - b.y) * 0.05, 18, 36);
    const sTop = sa.y, sBot = sa.y + sa.h, tTop = sb.y, tBot = sb.y + sb.h;
    let midY;
    if (tTop - sBot >= 16) midY = (sBot + tTop) / 2;
    else if (sTop - tBot >= 16) midY = (tBot + sTop) / 2;
    else midY = Math.max(sBot, tBot) + o;
    const x1 = Math.max(a.x, sa.x + sa.w) + o, x2 = Math.min(b.x, sb.x) - o;
    return roundedPath([a, { x: x1, y: a.y }, { x: x1, y: midY }, { x: x2, y: midY }, { x: x2, y: b.y }, b], 14);
  }
  // Rough rendered width (px) of a label at the given font size; CJK / full-width glyphs count as 1em.
  function textWidth(s, px) {
    let w = 0;
    const str = String(s == null ? "" : s);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      w += (c >= 0x2E80 && c <= 0x9FFF) || (c >= 0xAC00 && c <= 0xD7AF) || (c >= 0xF900 && c <= 0xFAFF) || (c >= 0xFF00 && c <= 0xFFEF) ? px : px * 0.6;
    }
    return w;
  }
  let uidSeq = 0;
  function optValue(o) { return o !== null && typeof o === "object" ? o.value : o; }
  function optLabel(o) { return o !== null && typeof o === "object" ? (o.label != null ? o.label : String(o.value)) : String(o); }

  function mount(host, opts) {
    opts = opts || {};
    const graph = opts.graph;
    if (!host || !graph) throw new Error("SeaGraph.Canvas.mount 需要 hostEl 與 opts.graph");
    const registry = opts.registry || SG.registry || null;
    const types = opts.types || SG.types || null;
    const labels = Object.assign({}, DEFAULT_LABELS, opts.labels || {});
    const readOnly = !!opts.readOnly;
    const doc = host.ownerDocument || root.document;
    const win = doc.defaultView || root;
    const raf = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : function (f) { return setTimeout(f, 16); };

    function mk(tag, cls, attrs, text) {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
      if (text != null) e.textContent = text;
      return e;
    }
    function svg(tag, attrs) {
      const e = doc.createElementNS(SVGNS, tag);
      if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
      return e;
    }

    // ---------- DOM skeleton ----------
    const rootEl = mk("div", "sg-canvas" + (readOnly ? " sg-readonly" : ""), {
      tabindex: "0", role: "application", "aria-label": labels.canvas,
      "aria-roledescription": "節點畫布"
    });
    const world = mk("div", "sg-world");
    const loopsLayer = mk("div", "sg-loops", { "aria-hidden": "true" });
    const groupsLayer = mk("div", "sg-groups");
    const wiresSvg = svg("svg", { class: "sg-wires", width: "1", height: "1", "aria-hidden": "true", focusable: "false" });
    const wiresG = svg("g");
    const ghost = svg("path", { class: "sg-ghost" });
    ghost.style.display = "none";
    wiresSvg.append(wiresG, ghost);
    const nodesLayer = mk("div", "sg-nodes");
    world.append(loopsLayer, groupsLayer, wiresSvg, nodesLayer);
    const boxEl = mk("div", "sg-box");
    boxEl.hidden = true;
    const uid = "sg" + (++uidSeq);

    // empty-state card (shown only while the graph has no nodes)
    const emptyEl = mk("div", "sg-empty", { role: "group", "aria-labelledby": uid + "-empty-t" });
    const emptyBtn = mk("button", "sg-empty-btn", { type: "button" }, labels.emptyAction);
    emptyEl.append(
      mk("p", "sg-empty-title", { id: uid + "-empty-t" }, labels.emptyTitle),
      mk("p", "sg-empty-hint", null, readOnly ? labels.emptyReadOnly : labels.empty)
    );
    if (!readOnly) emptyEl.append(emptyBtn);
    emptyEl.hidden = true;

    // floating view controls (bottom-left)
    function icon(d) {
      const s = svg("svg", { viewBox: "0 0 24 24", width: "16", height: "16", "aria-hidden": "true", focusable: "false" });
      s.append(svg("path", { d: d, fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }));
      return s;
    }
    function ctlBtn(cls, label, iconPath, extra) {
      const b = mk("button", "sg-ctl " + cls, Object.assign({ type: "button", "aria-label": label, title: label }, extra || {}));
      if (iconPath) b.append(icon(iconPath));
      return b;
    }
    const controls = mk("div", "sg-controls", { role: "toolbar", "aria-label": labels.controls });
    const zoomOutBtn = ctlBtn("sg-ctl-out", "縮小", "M6 12h12", { "aria-keyshortcuts": "-" });
    const zoomBtn = mk("button", "sg-ctl sg-ctl-zoom", { type: "button", "aria-keyshortcuts": "0", title: "重設為 100%" }, "100%");
    const zoomInBtn = ctlBtn("sg-ctl-in", "放大", "M12 6v12M6 12h12", { "aria-keyshortcuts": "+" });
    const fitBtn = ctlBtn("sg-ctl-fit", "適合畫布", "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5", { "aria-keyshortcuts": "F" });
    const mmBtn = ctlBtn("sg-ctl-mm", "小地圖", "M3 5h18v14H3zM13 12h5v4h-5z", { "aria-pressed": "false" });
    controls.append(zoomOutBtn, zoomBtn, zoomInBtn, mk("span", "sg-ctl-sep", { "aria-hidden": "true" }), fitBtn, mmBtn);

    rootEl.append(controls, world, boxEl, emptyEl);
    host.append(rootEl);

    // ---------- state ----------
    let view = normView(graph.view);
    let viewTimer = 0;
    let destroyed = false;
    const sel = new Set();
    let selLink = null;
    const states = new Map();
    const linkStates = new Map();
    let loopRegions = [];
    const loopEls = new Map();
    const nodeEls = new Map();
    const linkEls = new Map();
    const groupEls = new Map();
    const slotsCache = new Map();
    let linkedIn = new Set();
    let linkedOut = new Set();
    let pending = null;      // {id, dir:"in"|"out", slot}
    let gesture = null;
    let menu = null;
    let searchPop = null;
    let spaceHeld = false;
    let pointerInside = false;
    let lastPointer = null;   // {cx, cy} client
    let usingPointer = false;
    let suppressClickAt = 0;
    let renderQueued = false;
    let renderFull = false;
    let wiresQueued = false;
    let pendingFocus = null;
    let snap = Number(opts.snap) || 0;
    const listeners = {};
    let minimap = null;
    let minimapOn = false;
    let minimapAuto = true;    // true until the user toggles: follows host width (< 700px → hidden)
    const touches = new Map(); // touch pointerId -> {x, y} (client)
    const pvOpen = new Set();  // node ids whose inline preview is expanded
    let lastPct = -1;
    let resizeObs = null;

    function status(text) { if (opts.onStatus && text) { try { opts.onStatus(text); } catch (e) { /* ignore */ } } }
    function emit(evt, data) { (listeners[evt] || []).slice().forEach(function (fn) { try { fn(data); } catch (e) { /* ignore */ } }); }
    function on(evt, fn) {
      (listeners[evt] = listeners[evt] || []).push(fn);
      return function () { listeners[evt] = (listeners[evt] || []).filter(function (f) { return f !== fn; }); };
    }

    // ---------- graph helpers ----------
    function nodes() { return graph.nodes || []; }
    function links() { return graph.links || []; }
    function groups() { return graph.groups || []; }
    function getNode(id) {
      if (typeof graph.getNode === "function") return graph.getNode(id) || null;
      return nodes().find(function (n) { return n.id === id; }) || null;
    }
    function defOf(n) {
      if (!n || !registry || typeof registry.get !== "function") return null;
      try { return registry.get(n.type) || null; } catch (e) { return null; }
    }
    function slotsOf(id) {
      let s = slotsCache.get(id);
      if (!s) {
        try { s = graph.slots(id); } catch (e) { s = null; }
        s = s || { inputs: [], outputs: [] };
        s = { inputs: s.inputs || [], outputs: s.outputs || [] };
        slotsCache.set(id, s);
      }
      return s;
    }
    function findSlot(id, dir, name) {
      const s = slotsOf(id);
      return (dir === "out" ? s.outputs : s.inputs).find(function (x) { return x.name === name; }) || null;
    }
    function typeInfo(t) {
      let info = null;
      if (types && typeof types.get === "function") { try { info = types.get(t); } catch (e) { info = null; } }
      return {
        id: t,
        label: (info && info.label) || (t === "*" ? "任意" : String(t || "")),
        color: (info && info.color) || (t === "*" ? "#9aa5b1" : "#8cb7ea")
      };
    }
    function titleOf(n) {
      if (!n) return "";
      const d = defOf(n);
      return n.title || (d && d.title) || n.type;
    }
    function slotLabel(id, dir, name) {
      const s = findSlot(id, dir, name);
      return (s && (s.label || s.name)) || name;
    }
    function cc(from, out, to, inp) {
      try {
        const r = graph.canConnect(from, out, to, inp);
        return r && typeof r === "object" ? r : { ok: !!r };
      } catch (e) { return { ok: false, reason: e && e.message }; }
    }
    function can(h, key) {
      if (!h) return false;
      const v = h[key];
      return typeof v === "function" ? !!v.call(h) : !!v;
    }
    function mutate(fn) {
      if (readOnly) { status("唯讀模式，無法修改畫布。"); return undefined; }
      let out;
      try {
        if (typeof graph.batch === "function") graph.batch(function () { out = fn(); });
        else out = fn();
      } catch (err) {
        status("操作失敗：" + ((err && err.message) || err));
        return undefined;
      }
      return out;
    }
    function asNode(r) { return typeof r === "string" ? getNode(r) : r; }

    // ---------- view ----------
    function normView(v) {
      v = v || {};
      const k = clamp(Number(v.k) || 1, MIN_K, MAX_K);
      return { x: Number(v.x) || 0, y: Number(v.y) || 0, k: k };
    }
    function applyView() {
      world.style.transform = "translate(" + view.x + "px," + view.y + "px) scale(" + view.k + ")";
      const g = GRID * view.k;
      rootEl.style.backgroundSize = g + "px " + g + "px";
      rootEl.style.backgroundPosition = view.x + "px " + view.y + "px";
      const pct = Math.round(view.k * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        zoomBtn.textContent = pct + "%";
        zoomBtn.setAttribute("aria-label", "縮放 " + pct + "%，按下重設為 100%");
        // aria-disabled (not disabled) so a focused button keeps focus at the zoom limit
        zoomOutBtn.setAttribute("aria-disabled", view.k <= MIN_K + 1e-6 ? "true" : "false");
        zoomInBtn.setAttribute("aria-disabled", view.k >= MAX_K - 1e-6 ? "true" : "false");
      }
      emit("view", getView());
    }
    function getView() { return { x: view.x, y: view.y, k: view.k }; }
    function setViewLocal(v, persist) {
      view = normView(v);
      applyView();
      if (persist !== false) pushView();
    }
    function pushView() {
      if (viewTimer) clearTimeout(viewTimer);
      viewTimer = setTimeout(function () {
        viewTimer = 0;
        if (destroyed) return;
        try { if (typeof graph.setView === "function") graph.setView(getView()); } catch (e) { /* ignore */ }
      }, 150);
    }
    function rect() { return rootEl.getBoundingClientRect(); }
    function toWorld(cx, cy) {
      const r = rect();
      return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    }
    function toClient(wx, wy) {
      const r = rect();
      return { x: r.left + view.x + wx * view.k, y: r.top + view.y + wy * view.k };
    }
    function viewCenterWorld() {
      return { x: (rootEl.clientWidth / 2 - view.x) / view.k, y: (rootEl.clientHeight / 2 - view.y) / view.k };
    }
    function zoomAt(cx, cy, k) {
      const r = rect();
      const sx = cx - r.left, sy = cy - r.top;
      k = clamp(k, MIN_K, MAX_K);
      const wx = (sx - view.x) / view.k, wy = (sy - view.y) / view.k;
      setViewLocal({ x: sx - wx * k, y: sy - wy * k, k: k });
    }
    function zoomTo(k) {
      const r = rect();
      zoomAt(r.left + rootEl.clientWidth / 2, r.top + rootEl.clientHeight / 2, k);
    }
    function nodeSize(id) {
      const rec = nodeEls.get(id);
      const n = getNode(id);
      return rec ? rec.size : { w: (n && n.w) || NODE_W, h: 80 };
    }
    function bbox(ids) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      ids.forEach(function (id) {
        const n = getNode(id); if (!n) return;
        const s = nodeSize(id);
        x1 = Math.min(x1, n.x); y1 = Math.min(y1, n.y);
        x2 = Math.max(x2, n.x + s.w); y2 = Math.max(y2, n.y + s.h);
      });
      return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    // Screen-space insets that fit() keeps free so fitted nodes never sit under the
    // floating controls (bottom-left) or the minimap (bottom-right). Two candidate layouts
    // when the minimap is shown (reserve a bottom strip vs. a right column); fit() picks the
    // one that yields the larger zoom.
    function fitInsets(W, H) {
      const pad = W < 520 ? 24 : 40;
      const ctlH = controls.hidden ? 0 : (controls.offsetHeight || 36) + 10;
      const base = { l: pad, t: pad, r: pad, b: pad + ctlH };
      const mm = minimapOn && minimap && minimap.el && !minimap.el.hidden ? minimap.el : null;
      if (!mm) return [base];
      const mw = (mm.offsetWidth || 160) + 10, mh = (mm.offsetHeight || 100) + 10;
      return [
        { l: pad, t: pad, r: pad, b: pad + Math.max(ctlH, mh) },
        { l: pad, t: pad, r: pad + mw, b: pad + ctlH }
      ];
    }
    function fit() {
      const ids = nodes().map(function (n) { return n.id; });
      const b = bbox(ids);
      if (!b) { setViewLocal({ x: 0, y: 0, k: 1 }); return; }
      // backward wires detour up to ~36 world units outside their nodes; keep them in view too
      links().forEach(function (l) {
        const a = anchor(l.from, "out", l.out), t = anchor(l.to, "in", l.in);
        if (!a || !t || t.x - a.x >= 24) return;
        const x1 = Math.min(b.x, t.x - 36), x2 = Math.max(b.x + b.w, a.x + 36);
        b.w = x2 - x1; b.x = x1;
      });
      const W = rootEl.clientWidth || 800, H = rootEl.clientHeight || 600;
      let best = null;
      fitInsets(W, H).forEach(function (ins) {
        const aw = Math.max(40, W - ins.l - ins.r), ah = Math.max(40, H - ins.t - ins.b);
        const k = clamp(Math.min(aw / Math.max(b.w, 1), ah / Math.max(b.h, 1), 1.25), MIN_K, MAX_K);
        if (!best || k > best.k + 1e-6) best = { k: k, ins: ins, aw: aw, ah: ah };
      });
      const k = best.k, ins = best.ins;
      setViewLocal({ x: ins.l + (best.aw - b.w * k) / 2 - b.x * k, y: ins.t + (best.ah - b.h * k) / 2 - b.y * k, k: k });
    }
    function centerOn(id) {
      const n = getNode(id); if (!n) return;
      const s = nodeSize(id);
      const W = rootEl.clientWidth, H = rootEl.clientHeight;
      setViewLocal({ x: W / 2 - (n.x + s.w / 2) * view.k, y: H / 2 - (n.y + s.h / 2) * view.k, k: view.k });
    }
    function ensureVisible(id) {
      const n = getNode(id); if (!n) return;
      const s = nodeSize(id), k = view.k, m = 24;
      const W = rootEl.clientWidth, H = rootEl.clientHeight;
      const x1 = n.x * k + view.x, y1 = n.y * k + view.y, x2 = x1 + s.w * k, y2 = y1 + s.h * k;
      let dx = 0, dy = 0;
      if (x2 > W - m) dx = W - m - x2;
      if (x1 + dx < m) dx = m - x1;
      if (y2 > H - m) dy = H - m - y2;
      if (y1 + dy < m) dy = m - y1;
      if (dx || dy) setViewLocal({ x: view.x + dx, y: view.y + dy, k: k });
    }

    // ---------- rendering ----------
    function scheduleRender(viewOnly) {
      if (destroyed) return;
      if (!viewOnly) renderFull = true;
      if (renderQueued) return;
      renderQueued = true;
      raf(function () { renderQueued = false; render(); });
    }
    function scheduleWires() {
      if (wiresQueued || destroyed) return;
      wiresQueued = true;
      raf(function () { wiresQueued = false; drawWires(); emit("move"); });
    }

    function render() {
      if (destroyed) return;
      const full = renderFull;
      renderFull = false;
      if (!viewTimer && graph.view) {
        const gv = normView(graph.view);
        if (gv.x !== view.x || gv.y !== view.y || gv.k !== view.k) view = gv;
      }
      applyView();
      if (!full) return;
      slotsCache.clear();
      const active = doc.activeElement;
      const hadFocusInside = rootEl.contains(active) && active !== rootEl;
      linkedIn = new Set(); linkedOut = new Set();
      links().forEach(function (l) { linkedIn.add(l.to + "\u0000" + l.in); linkedOut.add(l.from + "\u0000" + l.out); });

      const seen = new Set();
      let selChanged = false;
      nodes().forEach(function (n) {
        seen.add(n.id);
        const sig = signature(n);
        let rec = nodeEls.get(n.id);
        if (!rec || rec.sig !== sig) {
          let focusKey = null;
          if (rec && rec.el.contains(active) && active.dataset) focusKey = active.dataset.focus || null;
          const nrec = buildNode(n, sig);
          if (rec) rec.el.replaceWith(nrec.el); else nodesLayer.append(nrec.el);
          nodeEls.set(n.id, nrec);
          rec = nrec;
          if (focusKey) focusByKey(rec.el, focusKey);
        }
        updateNode(n, rec, active);
      });
      nodeEls.forEach(function (rec, id) {
        if (!seen.has(id)) {
          rec.el.remove(); nodeEls.delete(id); states.delete(id);
          if (sel.delete(id)) selChanged = true;
        }
      });
      linkStates.forEach(function (v, id) { if (!links().some(function (l) { return l.id === id; })) linkStates.delete(id); });
      if (pending && !seen.has(pending.id)) cancelPending(false);
      if (selLink && !links().some(function (l) { return l.id === selLink; })) selLink = null;
      renderGroups(active);
      computeLoops();
      nodeEls.forEach(measure);
      drawWires();
      if (pending) applyPending();
      emptyEl.hidden = nodes().length > 0;
      if (pendingFocus) {
        const r = nodeEls.get(pendingFocus);
        pendingFocus = null;
        if (r) { r.titleBtn.focus({ preventScroll: true }); ensureVisible(r.id); }
      } else if (hadFocusInside && !rootEl.contains(doc.activeElement)) {
        rootEl.focus({ preventScroll: true });
      }
      if (selChanged) notifySelect();
      emit("render");
    }

    function focusByKey(scope, key) {
      const all = scope.querySelectorAll("[data-focus]");
      for (let i = 0; i < all.length; i++) {
        if (all[i].dataset.focus === key) { all[i].focus({ preventScroll: true }); return true; }
      }
      return false;
    }

    function signature(n) {
      const s = slotsOf(n.id);
      const d = defOf(n);
      return JSON.stringify([
        n.type, titleOf(n), !!n.collapsed, !!(n.missing || !d), n.w || 0,
        (n.converted || []).join(","),
        s.inputs.map(function (i) { return [i.name, i.type, i.label, !!i.optional]; }),
        s.outputs.map(function (o) { return [o.name, o.type, o.label]; }),
        d ? (d.widgets || []).map(function (w) { return [w.name, w.kind, w.label, w.options || null, w.min, w.max, w.step, w.maxLength]; }) : null,
        n.missing ? n.widgets || null : null
      ]);
    }

    function portBtn(n, slot, dir) {
      const t = typeInfo(slot.type);
      const lab = slot.label || slot.name;
      const b = mk("button", "sg-port", {
        type: "button",
        "data-dir": dir,
        "data-slot": slot.name,
        "data-focus": "port:" + dir + ":" + slot.name,
        "aria-label": (dir === "in" ? labels.input : labels.output) + " " + lab + "（" + t.label + "）" +
          (slot.optional ? "，選填" : ""),
        "aria-pressed": "false",
        title: lab + "：" + t.label
      });
      b.style.setProperty("--pc", t.color);
      if (readOnly) b.disabled = true;
      return b;
    }

    function buildNode(n, sig) {
      const d = defOf(n);
      const missing = !!n.missing || !d;
      const isReroute = n.type === "core/reroute";
      const title = titleOf(n);
      const el = mk("div", "sg-node", { role: "group", "aria-label": title + " " + labels.nodeSuffix });
      el.dataset.node = n.id;
      const rec = {
        id: n.id, el: el, sig: sig, collapsed: !!n.collapsed && !isReroute, reroute: isReroute,
        ports: { in: new Map(), out: new Map() }, offs: { in: {}, out: {} },
        widgets: new Map(), size: { w: 0, h: 0 }, headH: 28, title: title,
        last: {}
      };
      if (missing) el.classList.add("sg-missing");
      if (isReroute) {
        el.classList.add("sg-reroute");
        const s = slotsOf(n.id);
        const head = mk("div", "sg-head");
        const inp = s.inputs[0], out = s.outputs[0];
        if (inp) { const b = portBtn(n, inp, "in"); rec.ports.in.set(inp.name, b); head.append(b); }
        const handle = mk("button", "sg-title", { type: "button", "data-focus": "title", "aria-label": title + "（拖曳移動）", title: title }, "•");
        head.append(handle);
        if (out) { const b = portBtn(n, out, "out"); rec.ports.out.set(out.name, b); head.append(b); }
        el.append(head);
        rec.head = head; rec.titleBtn = handle;
        rec.badge = mk("span", "sg-badge"); rec.badge.hidden = true;
        rec.modeBadge = mk("span", "sg-badge sg-mode-badge"); rec.modeBadge.hidden = true;
        rec.flowBadge = mk("span", "sg-badge sg-flow-badge"); rec.flowBadge.hidden = true;
        rec.retryBadge = mk("span", "sg-badge sg-retry-badge"); rec.retryBadge.hidden = true;
        return rec;
      }
      el.style.width = (n.w || NODE_W) + "px";
      if (rec.collapsed) el.classList.add("sg-collapsed");

      const head = mk("div", "sg-head");
      const colBtn = mk("button", "sg-collapse-btn", {
        type: "button", "data-focus": "collapse",
        "aria-label": (rec.collapsed ? "展開 " : "摺疊 ") + title,
        "aria-expanded": rec.collapsed ? "false" : "true"
      }, rec.collapsed ? "▸" : "▾");
      const titleBtn = mk("button", "sg-title", {
        type: "button", "data-focus": "title",
        "aria-label": title + "（拖曳或用方向鍵移動，Enter 開啟設定）", title: title
      }, title);
      const modeBadge = mk("span", "sg-badge sg-mode-badge");
      modeBadge.hidden = true;
      const badge = mk("span", "sg-badge");
      badge.hidden = true;
      const flowBadge = mk("span", "sg-badge sg-flow-badge");
      flowBadge.hidden = true;
      const retryBadge = mk("span", "sg-badge sg-retry-badge");
      retryBadge.hidden = true;
      const menuBtn = mk("button", "sg-menu-btn", {
        type: "button", "data-focus": "menu", "aria-haspopup": "menu",
        "aria-label": labels.menu + "：" + title
      }, "⋯");
      head.append(colBtn, titleBtn, retryBadge, modeBadge, flowBadge, badge, menuBtn);
      const prog = mk("div", "sg-progress", { role: "progressbar", "aria-label": title + " 進度", "aria-valuemin": "0", "aria-valuemax": "100" });
      prog.hidden = true;
      const bar = mk("i");
      prog.append(bar);
      el.append(head, prog);
      Object.assign(rec, { head: head, titleBtn: titleBtn, badge: badge, modeBadge: modeBadge, flowBadge: flowBadge, retryBadge: retryBadge, prog: prog, bar: bar, menuBtn: menuBtn });

      if (missing) {
        const note = mk("div", "sg-missing-note", null, labels.missing + "：" + n.type);
        el.append(note);
      }
      if (!rec.collapsed) {
        const s = slotsOf(n.id);
        const body = mk("div", "sg-body");
        const rows = Math.max(s.inputs.length, s.outputs.length);
        for (let i = 0; i < rows; i++) {
          const row = mk("div", "sg-row");
          const a = s.inputs[i], o = s.outputs[i];
          const left = mk("div", "sg-slot sg-slot-in");
          if (a) {
            const b = portBtn(n, a, "in");
            rec.ports.in.set(a.name, b);
            const lab = mk("span", "sg-slot-label" + (a.optional ? " sg-optional" : ""), { title: (a.label || a.name) + (a.optional ? "（選填）" : "") }, a.label || a.name);
            left.append(b, lab);
          }
          const right = mk("div", "sg-slot sg-slot-out");
          if (o) {
            const b = portBtn(n, o, "out");
            rec.ports.out.set(o.name, b);
            right.append(mk("span", "sg-slot-label", { title: o.label || o.name }, o.label || o.name), b);
          }
          row.append(left, right);
          body.append(row);
        }
        const converted = n.converted || [];
        if (d && d.widgets) {
          d.widgets.forEach(function (w) {
            if (converted.indexOf(w.name) >= 0) return;
            body.append(buildWidget(n, w, rec));
          });
        }
        if (missing && n.widgets && Object.keys(n.widgets).length) {
          const raw = mk("div", "sg-raw", null, Object.keys(n.widgets).map(function (k) { return k + "：" + String(n.widgets[k]); }).join("\n"));
          body.append(raw);
        }
        el.append(body);
        const approval = mk("div", "sg-approval", { role: "group", "aria-label": "核准 " + title });
        approval.hidden = true;
        const apMsg = mk("p", "sg-approval-msg");
        const apYes = mk("button", "sg-approve", { type: "button", "data-focus": "approve", "aria-label": "核准 " + title }, "核准");
        const apNo = mk("button", "sg-reject", { type: "button", "data-focus": "reject", "aria-label": "拒絕 " + title }, "拒絕");
        const apBtns = mk("div", "sg-approval-btns");
        apBtns.append(apYes, apNo);
        approval.append(apMsg, apBtns);
        const pvId = uid + "-pv-" + String(n.id).replace(/[^\w-]/g, "_");
        const pvWrap = mk("div", "sg-pv");
        pvWrap.hidden = true;
        const preview = mk("div", "sg-preview sg-pv-clamp", { id: pvId, tabindex: "0", role: "note", "aria-label": labels.preview + "：" + title, "data-focus": "preview" });
        const pvToggle = mk("button", "sg-pv-toggle", {
          type: "button", "data-focus": "pv-toggle", "aria-controls": pvId, "aria-expanded": "false",
          "aria-label": "展開預覽：" + title
        }, "展開");
        pvToggle.hidden = true;
        pvWrap.append(preview, pvToggle);
        const msg = mk("div", "sg-msg", { role: "note" });
        msg.hidden = true;
        el.append(approval, pvWrap, msg);
        Object.assign(rec, { approval: approval, apMsg: apMsg, pvWrap: pvWrap, preview: preview, pvToggle: pvToggle, pvText: null, msg: msg });
      }
      return rec;
    }

    function widgetValue(n, w) {
      return n && n.widgets && Object.prototype.hasOwnProperty.call(n.widgets, w.name) ? n.widgets[w.name] : w.default;
    }

    function buildWidget(n, w, rec) {
      const kind = w.kind || "text";
      const text = w.label || w.name;
      // Long labels stack above a full-width control instead of being truncated inline.
      // Toggles keep the switch on the right and let the label wrap.
      const inner = (n.w || NODE_W) - 18;
      const stacked = kind === "textarea" || (kind !== "toggle" && textWidth(text, 12) > inner * 0.4);
      const wrap = mk("label", "sg-widget sg-w-" + kind + (stacked ? " sg-w-stack" : ""));
      const lab = mk("span", "sg-wlabel", { title: text }, text);
      let ctl;
      if (kind === "textarea") {
        ctl = mk("textarea", "sg-input", { rows: "3", spellcheck: "false" });
        if (w.maxLength) ctl.maxLength = w.maxLength;
      } else if (kind === "number") {
        ctl = mk("input", "sg-input", { type: "number", inputmode: "decimal" });
        if (w.min != null) ctl.min = w.min;
        if (w.max != null) ctl.max = w.max;
        ctl.step = w.step != null ? w.step : "any";
      } else if (kind === "select") {
        ctl = mk("select", "sg-input");
        (w.options || []).forEach(function (o, i) {
          const op = mk("option", null, { value: String(i) }, optLabel(o));
          ctl.append(op);
        });
      } else if (kind === "toggle") {
        ctl = mk("input", "sg-check", { type: "checkbox", role: "switch" });
      } else {
        ctl = mk("input", "sg-input", { type: "text", spellcheck: "false" });
        if (w.maxLength) ctl.maxLength = w.maxLength;
      }
      ctl.dataset.focus = "w:" + w.name;
      ctl.dataset.widget = w.name;
      if (readOnly) ctl.disabled = true;
      setControl(ctl, w, widgetValue(n, w));
      const commit = function () { commitWidget(n.id, w, ctl); };
      ctl.addEventListener("change", commit);
      if (kind === "text" || kind === "number") {
        ctl.addEventListener("keydown", function (e) {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          else if (e.key === "Escape") {
            e.preventDefault(); e.stopPropagation();
            setControl(ctl, w, widgetValue(getNode(n.id), w));
            rootEl.focus({ preventScroll: true });
          }
        });
      } else if (kind === "textarea") {
        ctl.addEventListener("keydown", function (e) {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); commit(); rec.titleBtn.focus({ preventScroll: true }); }
        });
      }
      wrap.append(lab, ctl);
      rec.widgets.set(w.name, { ctl: ctl, w: w });
      return wrap;
    }

    function setControl(ctl, w, v) {
      const kind = w.kind || "text";
      if (kind === "toggle") { ctl.checked = !!v; return; }
      if (kind === "select") {
        const opts2 = w.options || [];
        let idx = opts2.findIndex(function (o) { return optValue(o) === v; });
        if (idx < 0) idx = opts2.findIndex(function (o) { return String(optValue(o)) === String(v); });
        ctl.value = String(Math.max(0, idx));
        return;
      }
      const s = v == null ? "" : String(v);
      if (ctl.value !== s) ctl.value = s;
    }

    function readControl(ctl, w) {
      const kind = w.kind || "text";
      if (kind === "toggle") return { ok: true, v: ctl.checked };
      if (kind === "select") {
        const o = (w.options || [])[Number(ctl.value)];
        return { ok: o !== undefined, v: optValue(o) };
      }
      if (kind === "number") {
        if (ctl.value.trim() === "") return { ok: false };
        let v = Number(ctl.value);
        if (!Number.isFinite(v)) return { ok: false };
        if (w.min != null) v = Math.max(Number(w.min), v);
        if (w.max != null) v = Math.min(Number(w.max), v);
        return { ok: true, v: v };
      }
      return { ok: true, v: ctl.value };
    }

    function commitWidget(id, w, ctl) {
      const n = getNode(id);
      if (!n || readOnly) return;
      const r = readControl(ctl, w);
      const cur = widgetValue(n, w);
      if (!r.ok) { setControl(ctl, w, cur); status("「" + (w.label || w.name) + "」需要有效的數字，已還原。"); return; }
      if (r.v === cur) return;
      mutate(function () { graph.setWidget(id, w.name, r.v); });
      if ((w.kind || "text") === "number") setControl(ctl, w, widgetValue(getNode(id), w));
      status("已更新「" + titleOf(n) + "」的" + (w.label || w.name) + "。");
    }

    function visualPos(n) {
      if (gesture && gesture.moving && gesture.moving.has(n.id)) return { x: n.x + gesture.dx, y: n.y + gesture.dy };
      return { x: n.x, y: n.y };
    }

    function nodeAria(n, rec) {
      let s = titleOf(n) + " " + labels.nodeSuffix;
      if (n.mode && MODE_TEXT[n.mode]) s += "，" + MODE_TEXT[n.mode];
      const st = states.get(n.id);
      if (st && st.status === "skipped" && st.message === "branch") s += "，未走此分支";
      else if (st && STATUS_TEXT[st.status]) s += "，" + STATUS_TEXT[st.status];
      if (st && st.iteration && st.iteration.max) s += "，第 " + (Number(st.iteration.index) + 1) + "/" + st.iteration.max + " 輪";
      if (st && st.attempt && st.attempt.max) s += "，重試 " + st.attempt.n + "/" + st.attempt.max;
      if (sel.has(n.id)) s += "，已選取";
      return s;
    }

    function updateNode(n, rec, active) {
      const el = rec.el, p = visualPos(n), L = rec.last;
      if (L.x !== p.x) { el.style.left = p.x + "px"; L.x = p.x; }
      if (L.y !== p.y) { el.style.top = p.y + "px"; L.y = p.y; }
      const mode = n.mode || "normal";
      if (L.mode !== mode) {
        el.classList.toggle("sg-mode-bypass", mode === "bypass");
        el.classList.toggle("sg-mode-mute", mode === "mute");
        rec.modeBadge.hidden = !MODE_TEXT[mode];
        rec.modeBadge.textContent = MODE_TEXT[mode] || "";
        L.mode = mode;
      }
      el.classList.toggle("sg-sel", sel.has(n.id));
      const rmax = n.retry && Number(n.retry.max) > 0 ? Number(n.retry.max) : 0;
      if (L.retry !== rmax) {
        rec.retryBadge.hidden = !rmax;
        rec.retryBadge.textContent = rmax ? "\u21bb" + rmax : "";
        if (rmax) rec.retryBadge.setAttribute("title", "失敗時最多重試 " + rmax + " 次");
        L.retry = rmax;
      }
      rec.widgets.forEach(function (o) {
        if (o.ctl !== active) setControl(o.ctl, o.w, widgetValue(n, o.w));
      });
      rec.ports.in.forEach(function (b, name) { b.classList.toggle("sg-linked", linkedIn.has(n.id + "\u0000" + name)); });
      rec.ports.out.forEach(function (b, name) { b.classList.toggle("sg-linked", linkedOut.has(n.id + "\u0000" + name)); });
      applyState(n, rec);
    }

    function applyState(n, rec) {
      const st = states.get(n.id) || { status: "idle" };
      const el = rec.el;
      STATUSES.forEach(function (s) { el.classList.toggle("sg-st-" + s, st.status === s); });
      const branchOff = st.status === "skipped" && st.message === "branch";
      el.classList.toggle("sg-branch-off", branchOff);
      const flow = [];
      if (st.iteration && st.iteration.max) flow.push("第 " + (Number(st.iteration.index) + 1) + "/" + st.iteration.max + " 輪");
      if (st.attempt && st.attempt.max) flow.push("重試 " + st.attempt.n + "/" + st.attempt.max);
      rec.flowBadge.hidden = !flow.length;
      rec.flowBadge.textContent = flow.join(" · ");
      el.setAttribute("aria-label", nodeAria(n, rec));
      if (st.status === "running") el.setAttribute("aria-busy", "true"); else el.removeAttribute("aria-busy");
      const text = branchOff ? "未走此分支" : (STATUS_TEXT[st.status] || "");
      rec.badge.hidden = !text;
      rec.badge.textContent = text;
      rec.badge.dataset.status = st.status;
      if (rec.prog) {
        const running = st.status === "running";
        rec.prog.hidden = !running;
        if (running) {
          const has = typeof st.progress === "number" && isFinite(st.progress);
          rec.prog.classList.toggle("sg-indet", !has);
          rec.bar.style.width = has ? Math.round(clamp(st.progress, 0, 1) * 100) + "%" : "";
          if (has) rec.prog.setAttribute("aria-valuenow", String(Math.round(clamp(st.progress, 0, 1) * 100)));
          else rec.prog.removeAttribute("aria-valuenow");
        }
      }
      if (rec.preview) {
        const pv = st.preview != null && st.preview !== "" ? String(st.preview) : null;
        rec.pvWrap.hidden = pv == null;
        if (pv != null && rec.preview.textContent !== pv) rec.preview.textContent = pv;
        if (pv !== rec.pvText) { rec.pvText = pv; clampPreview(rec); }
      }
      if (rec.msg) {
        const m = st.message && !branchOff ? String(st.message) : "";
        rec.msg.hidden = !m;
        if (rec.msg.textContent !== m) rec.msg.textContent = m;
        rec.msg.classList.toggle("sg-msg-error", st.status === "error");
      }
      if (rec.approval) {
        const ap = st.approval && !readOnly ? st.approval : null;
        rec.approval.hidden = !ap;
        if (ap) rec.apMsg.textContent = ap.message || "請確認是否繼續";
      }
    }

    // Inline previews are clamped to ~3 lines; a 展開／收合 toggle appears only when the text overflows.
    function clampPreview(rec) {
      const pv = rec.preview, tg = rec.pvToggle;
      if (!pv || rec.pvWrap.hidden) { if (tg) tg.hidden = true; return; }
      const open = pvOpen.has(rec.id);
      pv.classList.add("sg-pv-clamp");
      let over;
      if (pv.clientHeight > 0) over = pv.scrollHeight > pv.clientHeight + 2;
      else {
        const t = pv.textContent || "";
        over = t.split("\n").length > 3 || textWidth(t, 12) > ((rec.size.w || NODE_W) - 32) * 3;
      }
      pv.classList.toggle("sg-pv-clamp", !(open && over));
      tg.hidden = !over;
      tg.textContent = open ? "收合" : "展開";
      tg.setAttribute("aria-expanded", open && over ? "true" : "false");
      tg.setAttribute("aria-label", (open ? "收合預覽：" : "展開預覽：") + rec.title);
    }
    function togglePreview(id) {
      const rec = nodeEls.get(id);
      if (!rec || !rec.preview) return;
      if (pvOpen.has(id)) pvOpen.delete(id); else pvOpen.add(id);
      clampPreview(rec);
      measure(rec);
      scheduleWires();
      status(pvOpen.has(id) ? "已展開「" + rec.title + "」的預覽。" : "已收合「" + rec.title + "」的預覽。");
    }

    function measure(rec) {
      const el = rec.el;
      rec.size = { w: el.offsetWidth, h: el.offsetHeight };
      rec.headH = rec.head ? rec.head.offsetHeight : 28;
      const bx = el.clientLeft, by = el.clientTop;
      ["in", "out"].forEach(function (dir) {
        const o = {};
        rec.ports[dir].forEach(function (b, name) {
          if (b.offsetParent === el) {
            o[name] = { x: bx + b.offsetLeft + b.offsetWidth / 2, y: by + b.offsetTop + b.offsetHeight / 2 };
          } else {
            const br = b.getBoundingClientRect(), er = el.getBoundingClientRect();
            o[name] = { x: (br.left + br.width / 2 - er.left) / view.k, y: (br.top + br.height / 2 - er.top) / view.k };
          }
        });
        rec.offs[dir] = o;
      });
    }

    function anchor(id, dir, name) {
      const n = getNode(id), rec = nodeEls.get(id);
      if (!n || !rec) return null;
      const p = visualPos(n);
      let o = rec.offs[dir][name];
      if (!o) o = { x: dir === "out" ? rec.size.w : 0, y: rec.headH / 2 };
      return { x: p.x + o.x, y: p.y + o.y };
    }

    function nodeBox(id) {
      const n = getNode(id), p = visualPos(n), s = nodeSize(id);
      return { x: p.x, y: p.y, w: s.w, h: s.h };
    }

    function drawWires() {
      const seen = new Set();
      links().forEach(function (l) {
        seen.add(l.id);
        let rec = linkEls.get(l.id);
        const a = anchor(l.from, "out", l.out), b = anchor(l.to, "in", l.in);
        if (!rec) {
          const g = svg("g", { class: "sg-link" });
          g.dataset.link = l.id;
          const hit = svg("path", { class: "sg-wire-hit" });
          const path = svg("path", { class: "sg-wire" });
          g.append(hit, path);
          wiresG.append(g);
          rec = { g: g, hit: hit, path: path, color: null };
          linkEls.set(l.id, rec);
        }
        if (!a || !b) { rec.g.style.display = "none"; return; }
        rec.g.style.display = "";
        const s = findSlot(l.from, "out", l.out) || findSlot(l.to, "in", l.in);
        const color = typeInfo(s ? s.type : "*").color;
        if (rec.color !== color) { rec.path.style.stroke = color; rec.color = color; }
        const d = b.x - a.x < 24 ? backRoute(a, b, nodeBox(l.from), nodeBox(l.to)) : bez(a, b);
        rec.path.setAttribute("d", d);
        rec.hit.setAttribute("d", d);
        const fromN = getNode(l.from);
        rec.g.classList.toggle("sg-sel", selLink === l.id);
        rec.g.classList.toggle("sg-muted", !!fromN && fromN.mode === "mute");
        rec.g.classList.toggle("sg-detaching", !!(gesture && gesture.detach === l.id));
        rec.g.classList.toggle("sg-loop-wire", !!s && s.type === "LOOP");
        const ls = linkStates.get(l.id);
        rec.g.classList.toggle("sg-inactive", !!(ls && ls.inactive));
      });
      linkEls.forEach(function (rec, id) { if (!seen.has(id)) { rec.g.remove(); linkEls.delete(id); } });
      drawLoops();
    }

    function computeLoops() {
      const out = new Map(), inn = new Map();
      links().forEach(function (l) {
        if (!out.has(l.from)) out.set(l.from, []);
        if (!inn.has(l.to)) inn.set(l.to, []);
        out.get(l.from).push(l.to);
        inn.get(l.to).push(l.from);
      });
      function reach(start, adj) {
        const seen = new Set([start]), stack = [start];
        while (stack.length) {
          const id = stack.pop();
          (adj.get(id) || []).forEach(function (nx) { if (!seen.has(nx)) { seen.add(nx); stack.push(nx); } });
        }
        return seen;
      }
      const regions = [];
      links().forEach(function (l) {
        const a = getNode(l.from), b = getNode(l.to);
        if (!a || !b || a.type !== "core/loop-start" || b.type !== "core/loop-end") return;
        const s = findSlot(l.from, "out", l.out);
        if (!s || s.type !== "LOOP") return;
        const fwd = reach(a.id, out), back = reach(b.id, inn);
        const ids = Array.from(fwd).filter(function (id) { return back.has(id); });
        regions.push({ key: a.id + ">" + b.id, startId: a.id, endId: b.id, ids: ids });
      });
      loopRegions = regions;
    }
    function drawLoops() {
      const seen = new Set();
      loopRegions.forEach(function (r) {
        seen.add(r.key);
        let el = loopEls.get(r.key);
        if (!el) { el = mk("div", "sg-loop-region"); loopsLayer.append(el); loopEls.set(r.key, el); }
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        r.ids.forEach(function (id) {
          const n = getNode(id); if (!n) return;
          const p = visualPos(n), sz = nodeSize(id);
          x1 = Math.min(x1, p.x); y1 = Math.min(y1, p.y); x2 = Math.max(x2, p.x + sz.w); y2 = Math.max(y2, p.y + sz.h);
        });
        if (x1 === Infinity) { el.hidden = true; return; }
        el.hidden = false;
        const pad = 14;
        el.style.left = (x1 - pad) + "px"; el.style.top = (y1 - pad - 14) + "px";
        el.style.width = (x2 - x1 + pad * 2) + "px"; el.style.height = (y2 - y1 + pad * 2 + 14) + "px";
      });
      loopEls.forEach(function (el, key) { if (!seen.has(key)) { el.remove(); loopEls.delete(key); } });
    }

    function renderGroups(active) {
      let focusKey = null;
      if (active && groupsLayer.contains(active) && active.dataset) focusKey = active.dataset.focus;
      const seen = new Set();
      groups().forEach(function (g) {
        seen.add(g.id);
        let rec = groupEls.get(g.id);
        const color = g.color || GROUP_COLORS[0];
        const title = g.title || labels.group;
        const sig = title + "|" + color;
        if (!rec || rec.sig !== sig) {
          const el = mk("div", "sg-group");
          el.dataset.group = g.id;
          const tb = mk("button", "sg-gtitle", { type: "button", "data-focus": "g:" + g.id, "aria-label": labels.group + "「" + title + "」（拖曳移動群組與其中節點，Enter 選取群組內節點）" }, title);
          const rs = mk("div", "sg-gresize", { "aria-hidden": "true" });
          el.append(tb, rs);
          el.style.setProperty("--gc", color);
          if (rec) rec.el.replaceWith(el); else groupsLayer.append(el);
          rec = { el: el, tb: tb, sig: sig };
          groupEls.set(g.id, rec);
        }
        let x = g.x, y = g.y, w = g.w, h = g.h;
        if (gesture && gesture.gid === g.id) {
          if (gesture.kind === "group") { x += gesture.dx; y += gesture.dy; }
          if (gesture.kind === "gresize") { w = gesture.w; h = gesture.h; }
        }
        rec.el.style.left = x + "px"; rec.el.style.top = y + "px";
        rec.el.style.width = w + "px"; rec.el.style.height = h + "px";
      });
      groupEls.forEach(function (rec, id) { if (!seen.has(id)) { rec.el.remove(); groupEls.delete(id); } });
      if (focusKey && !groupsLayer.contains(doc.activeElement)) focusByKey(groupsLayer, focusKey);
    }

    // ---------- selection ----------
    function applySelection() {
      nodeEls.forEach(function (rec, id) {
        const n = getNode(id);
        rec.el.classList.toggle("sg-sel", sel.has(id));
        if (n) rec.el.setAttribute("aria-label", nodeAria(n, rec));
      });
      linkEls.forEach(function (rec, id) { rec.g.classList.toggle("sg-sel", selLink === id); });
    }
    function notifySelect() {
      const ids = Array.from(sel);
      if (opts.onSelect) { try { opts.onSelect(ids); } catch (e) { /* ignore */ } }
      emit("select", ids);
    }
    function setSelection(ids, quiet) {
      sel.clear();
      (ids || []).forEach(function (id) { if (getNode(id)) sel.add(id); });
      if (sel.size) selLink = null;
      applySelection();
      if (!quiet) notifySelect();
    }
    function selectLink(id) {
      selLink = id;
      if (sel.size) { sel.clear(); notifySelect(); }
      applySelection();
      status("已選取連線。按 Delete 移除，雙擊可插入轉接點。");
    }
    function targetIds(id) {
      if (id && !sel.has(id)) return [id];
      return Array.from(sel);
    }

    // ---------- connecting ----------
    function applyPending() {
      rootEl.classList.toggle("sg-connecting", !!pending);
      nodeEls.forEach(function (rec, nid) {
        ["in", "out"].forEach(function (dir) {
          rec.ports[dir].forEach(function (b, name) {
            const isP = !!pending && pending.id === nid && pending.dir === dir && pending.slot === name;
            b.setAttribute("aria-pressed", isP ? "true" : "false");
            let compat = false, dim = false;
            if (pending && dir !== pending.dir && !isP) {
              const r = pending.dir === "out" ? cc(pending.id, pending.slot, nid, name) : cc(nid, name, pending.id, pending.slot);
              compat = !!r.ok; dim = !r.ok;
            } else if (pending && dir === pending.dir && !isP) {
              dim = true;
            }
            b.classList.toggle("sg-compat", compat);
            b.classList.toggle("sg-dim", dim);
          });
        });
      });
    }
    function setPending(p) {
      pending = p;
      applyPending();
    }
    function cancelPending(announce) {
      const had = !!pending;
      pending = null;
      ghost.style.display = "none";
      applyPending();
      if (announce && had) status("已取消連線。");
    }
    function drawGhostTo(wpt) {
      if (!pending) { ghost.style.display = "none"; return; }
      const a = anchor(pending.id, pending.dir, pending.slot);
      if (!a) return;
      const s = findSlot(pending.id, pending.dir, pending.slot);
      ghost.style.stroke = typeInfo(s ? s.type : "*").color;
      ghost.setAttribute("d", pending.dir === "out" ? bez(a, wpt) : bez(wpt, a));
      ghost.style.display = "";
    }
    function tryConnect(from, out, to, inp) {
      const r = cc(from, out, to, inp);
      if (!r.ok) { status("無法連線：" + (r.reason || "型別不相容")); return false; }
      let link = null;
      mutate(function () { link = graph.connect(from, out, to, inp); });
      if (!link) { status("無法連線：" + labelFor(from) + " → " + labelFor(to)); return false; }
      status("已連線：" + labelFor(from) + "．" + slotLabel(from, "out", out) + " → " + labelFor(to) + "．" + slotLabel(to, "in", inp));
      return true;
    }
    function labelFor(id) { return titleOf(getNode(id)) || id; }
    function portInfo(port) {
      const nEl = port.closest(".sg-node");
      return { id: nEl && nEl.dataset.node, dir: port.dataset.dir, slot: port.dataset.slot };
    }
    function portClick(port) {
      if (readOnly) return;
      const p = portInfo(port);
      if (!p.id) return;
      const lab = slotLabel(p.id, p.dir, p.slot);
      if (!pending || pending.dir === p.dir) {
        if (pending && pending.id === p.id && pending.slot === p.slot) { cancelPending(true); return; }
        setPending(p);
        status(p.dir === "out"
          ? "已選取輸出「" + lab + "」，請點選相容的輸入（Esc 取消）。"
          : "已選取輸入「" + lab + "」，請點選相容的輸出（Esc 取消）。");
        return;
      }
      const a = pending.dir === "out" ? [pending.id, pending.slot, p.id, p.slot] : [p.id, p.slot, pending.id, pending.slot];
      if (tryConnect(a[0], a[1], a[2], a[3])) cancelPending(false);
    }
    function disconnectPort(port) {
      const p = portInfo(port);
      const ls = links().filter(function (l) {
        return p.dir === "in" ? (l.to === p.id && l.in === p.slot) : (l.from === p.id && l.out === p.slot);
      });
      if (!ls.length) { status("這個插槽沒有連線。"); return; }
      mutate(function () { ls.forEach(function (l) { graph.disconnect(l.id); }); });
      status("已移除 " + ls.length + " 條連線。");
    }
    function firstCompatible(nid, wantDir, src) {
      const s = slotsOf(nid);
      const arr = wantDir === "in" ? s.inputs : s.outputs;
      const okSlots = arr.filter(function (slot) {
        const r = wantDir === "in" ? cc(src.id, src.slot, nid, slot.name) : cc(nid, slot.name, src.id, src.slot);
        return r.ok;
      });
      if (!okSlots.length) return null;
      if (wantDir === "in") {
        const free = okSlots.find(function (slot) { return !linkedIn.has(nid + "\u0000" + slot.name); });
        return (free || okSlots[0]).name;
      }
      return okSlots[0].name;
    }
    function isEmptyTarget(t) {
      if (!t) return false;
      return t === rootEl || t === world || t === groupsLayer || t === nodesLayer || t === wiresSvg ||
        t === wiresG || t === emptyEl || (t.classList && t.classList.contains("sg-group"));
    }

    // ---------- mutations ----------
    function addAt(type, wx, wy, autoFrom) {
      if (readOnly) return null;
      let node = null;
      mutate(function () {
        node = asNode(graph.addNode(type, { x: Math.round(wx), y: Math.round(wy) }));
        if (node && autoFrom) autoConnect(node, autoFrom);
      });
      if (!node) { status("無法加入節點：" + type); return null; }
      setSelection([node.id]);
      pendingFocus = node.id;
      scheduleRender();
      status("已加入「" + titleOf(node) + "」。");
      return node;
    }
    function autoConnect(node, src) {
      let s;
      try { s = graph.slots(node.id); } catch (e) { s = null; }
      if (!s) return;
      if (src.dir === "out") {
        const inp = (s.inputs || []).find(function (i) { return cc(src.id, src.slot, node.id, i.name).ok; });
        if (inp) graph.connect(src.id, src.slot, node.id, inp.name);
      } else {
        const out = (s.outputs || []).find(function (o) { return cc(node.id, o.name, src.id, src.slot).ok; });
        if (out) graph.connect(node.id, out.name, src.id, src.slot);
      }
    }
    function removeSelected() {
      if (selLink) {
        const id = selLink;
        selLink = null;
        mutate(function () { graph.disconnect(id); });
        status("已移除連線。");
        return;
      }
      const ids = Array.from(sel);
      if (!ids.length) { status("沒有選取任何節點。"); return; }
      removeNodes(ids);
    }
    function removeNodes(ids) {
      if (!ids.length) return;
      mutate(function () { graph.removeNodes(ids); });
      ids.forEach(function (id) { sel.delete(id); });
      notifySelect();
      rootEl.focus({ preventScroll: true });
      status("已刪除 " + ids.length + " 個節點。");
    }
    function copySel(ids) {
      ids = ids || Array.from(sel);
      if (!ids.length) { status("請先選取要複製的節點。"); return false; }
      try { SG.__canvasClip = graph.copy(ids); } catch (e) { status("複製失敗：" + e.message); return false; }
      status("已複製 " + ids.length + " 個節點。");
      return true;
    }
    function pasteAt(wpt) {
      const clip = SG.__canvasClip;
      if (!clip) { status("剪貼簿是空的。"); return; }
      if (!wpt) {
        if (lastPointer && pointerInside) wpt = toWorld(lastPointer.cx, lastPointer.cy);
        else { const c = viewCenterWorld(); wpt = { x: c.x - 60, y: c.y - 40 }; }
      }
      let ids = null;
      mutate(function () { ids = graph.paste(clip, { x: Math.round(wpt.x), y: Math.round(wpt.y) }); });
      if (!ids || !ids.length) { status("沒有貼上任何節點。"); return; }
      setSelection(ids);
      status("已貼上 " + ids.length + " 個節點。");
    }
    function duplicate(ids) {
      if (!ids.length) return;
      const b = bbox(ids);
      let clip;
      try { clip = graph.copy(ids); } catch (e) { status("再製失敗：" + e.message); return; }
      let out = null;
      mutate(function () { out = graph.paste(clip, { x: b.x + 30, y: b.y + 30 }); });
      if (out && out.length) { setSelection(out); status("已再製 " + out.length + " 個節點。"); }
    }
    function setModes(ids, mode) {
      if (!ids.length) { status("請先選取節點。"); return; }
      const all = ids.every(function (id) { const n = getNode(id); return n && (n.mode || "normal") === mode; });
      const m = all && mode !== "normal" ? "normal" : mode;
      mutate(function () { ids.forEach(function (id) { graph.setMode(id, m); }); });
      status((m === "normal" ? "已恢復正常：" : m === "bypass" ? "已略過：" : "已停用：") + ids.length + " 個節點。");
    }
    function setTitle(id, title) {
      mutate(function () {
        if (typeof graph.setTitle === "function") graph.setTitle(id, title);
        else if (typeof graph.updateNode === "function") graph.updateNode(id, { title: title });
        else { const n = getNode(id); if (n) n.title = title; }
      });
      scheduleRender();
    }
    function setCollapsed(ids, value) {
      mutate(function () {
        ids.forEach(function (id) {
          if (typeof graph.setCollapsed === "function") graph.setCollapsed(id, value);
          else if (typeof graph.updateNode === "function") graph.updateNode(id, { collapsed: value });
          else { const n = getNode(id); if (n) n.collapsed = value; }
        });
      });
      scheduleRender();
      status((value ? "已摺疊 " : "已展開 ") + ids.length + " 個節點。");
    }
    function toggleCollapse(ids) {
      if (!ids.length) return;
      const n = getNode(ids[0]);
      setCollapsed(ids, !(n && n.collapsed));
    }
    function convert(id, w, toInput) {
      mutate(function () { graph.convertWidget(id, w.name, toInput); });
      status((toInput ? "已將「" : "已將「") + (w.label || w.name) + (toInput ? "」轉為輸入。" : "」轉回元件。"));
    }
    function undo() {
      const h = graph.history;
      if (!h || readOnly) return;
      if (!can(h, "canUndo")) { status("沒有可復原的動作。"); return; }
      try { h.undo(); status("已復原。"); } catch (e) { status("復原失敗：" + e.message); }
    }
    function redo() {
      const h = graph.history;
      if (!h || readOnly) return;
      if (!can(h, "canRedo")) { status("沒有可重做的動作。"); return; }
      try { h.redo(); status("已重做。"); } catch (e) { status("重做失敗：" + e.message); }
    }
    function groupSelection() {
      const ids = Array.from(sel);
      if (!ids.length) { status("請先選取要群組的節點。"); return; }
      const b = bbox(ids);
      const pad = 20, titleH = 32;
      const g = {
        title: labels.group, x: Math.round(b.x - pad), y: Math.round(b.y - pad - titleH),
        w: Math.round(b.w + pad * 2), h: Math.round(b.h + pad * 2 + titleH),
        color: GROUP_COLORS[groups().length % GROUP_COLORS.length]
      };
      mutate(function () { graph.addGroup(g); });
      status("已建立群組（" + ids.length + " 個節點）。");
    }
    function nodesInGroup(g) {
      return nodes().filter(function (n) {
        const s = nodeSize(n.id);
        const cx = n.x + s.w / 2, cy = n.y + Math.min(s.h, 40) / 2;
        return cx >= g.x && cx <= g.x + g.w && cy >= g.y && cy <= g.y + g.h;
      }).map(function (n) { return n.id; });
    }
    function insertReroute(linkId, wpt) {
      const l = links().find(function (x) { return x.id === linkId; });
      if (!l) return;
      if (!registry || !registry.get || !registry.get("core/reroute")) { status("沒有可用的轉接點節點類型。"); return; }
      let ok = false;
      mutate(function () {
        const r = asNode(graph.addNode("core/reroute", { x: Math.round(wpt.x - 20), y: Math.round(wpt.y - 12) }));
        if (!r) return;
        const s = graph.slots(r.id) || { inputs: [], outputs: [] };
        const rin = s.inputs[0], rout = s.outputs[0];
        if (!rin || !rout) return;
        graph.connect(l.from, l.out, r.id, rin.name);
        graph.connect(r.id, rout.name, l.to, l.in);
        if ((graph.links || []).some(function (x) { return x.id === l.id; })) graph.disconnect(l.id);
        ok = true;
      });
      selLink = null;
      status(ok ? "已插入轉接點。" : "無法插入轉接點。");
    }

    // ---------- inline rename ----------
    function inlineRename(anchorEl, current, ariaLabel, done) {
      const inp = mk("input", "sg-rename", { type: "text", "aria-label": ariaLabel, maxlength: "80" });
      inp.value = current;
      anchorEl.replaceWith(inp);
      inp.focus({ preventScroll: true });
      inp.select();
      let finished = false;
      function finish(commit) {
        if (finished) return;
        finished = true;
        inp.replaceWith(anchorEl);
        anchorEl.focus({ preventScroll: true });
        if (commit) done(inp.value.trim());
      }
      inp.addEventListener("keydown", function (e) {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); status("已取消重新命名。"); }
      });
      inp.addEventListener("blur", function () { finish(true); });
      inp.addEventListener("pointerdown", function (e) { e.stopPropagation(); });
    }
    function renameNode(id) {
      const rec = nodeEls.get(id), n = getNode(id);
      if (!rec || !n || readOnly || rec.reroute) return;
      inlineRename(rec.titleBtn, titleOf(n), "節點名稱", function (v) {
        if (v === titleOf(n)) return;
        setTitle(id, v || null);
        status("已重新命名為「" + (v || titleOf(getNode(id))) + "」。");
      });
    }
    function renameGroup(gid) {
      const rec = groupEls.get(gid);
      const g = groups().find(function (x) { return x.id === gid; });
      if (!rec || !g || readOnly) return;
      inlineRename(rec.tb, g.title || "", "群組名稱", function (v) {
        if (v === (g.title || "")) return;
        mutate(function () { graph.updateGroup(gid, { title: v || labels.group }); });
        status("已重新命名群組。");
      });
    }

    // ---------- menus ----------
    function openMenu(items, cx, cy, opener, label) {
      closeMenu(false);
      const m = mk("div", "sg-menu", { role: "menu", "aria-label": label || "選單" });
      const buttons = [];
      items.forEach(function (it) {
        if (!it) return;
        if (it.sep) { if (m.lastChild && !m.lastChild.classList.contains("sg-menu-sep")) m.append(mk("div", "sg-menu-sep", { role: "separator" })); return; }
        const b = mk("button", "sg-menu-item", { type: "button", role: it.checked != null ? "menuitemradio" : "menuitem", tabindex: "-1" });
        if (it.checked != null) b.setAttribute("aria-checked", it.checked ? "true" : "false");
        b.append(mk("span", null, null, (it.checked ? "✓ " : "") + it.label));
        if (it.key) { b.append(mk("span", "sg-menu-key", { "aria-hidden": "true" }, it.key)); b.setAttribute("aria-keyshortcuts", it.aria || it.key); }
        if (it.disabled) b.disabled = true;
        if (it.danger) b.classList.add("sg-danger");
        b.addEventListener("click", function () { closeMenu(false); it.run(); });
        m.append(b);
        buttons.push(b);
      });
      if (m.lastChild && m.lastChild.classList.contains("sg-menu-sep")) m.lastChild.remove();
      m.style.left = cx + "px";
      m.style.top = cy + "px";
      rootEl.append(m);
      const W = win.innerWidth, H = win.innerHeight;
      const mw = m.offsetWidth, mh = m.offsetHeight;
      m.style.left = clamp(cx, 4, Math.max(4, W - mw - 4)) + "px";
      m.style.top = clamp(cy, 4, Math.max(4, H - mh - 4)) + "px";
      const enabled = function () { return buttons.filter(function (b) { return !b.disabled; }); };
      m.addEventListener("keydown", function (e) {
        const list = enabled();
        const i = list.indexOf(doc.activeElement);
        if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
        else if (e.key === "Home") { e.preventDefault(); list[0].focus(); }
        else if (e.key === "End") { e.preventDefault(); list[list.length - 1].focus(); }
        else if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
        else if (e.key === "Tab") { e.preventDefault(); closeMenu(true); }
        e.stopPropagation();
      });
      const outside = function (e) { if (menu && !m.contains(e.target)) closeMenu(false); };
      doc.addEventListener("pointerdown", outside, true);
      menu = { el: m, opener: opener, outside: outside };
      if (opener && opener.setAttribute) opener.setAttribute("aria-expanded", "true");
      const first = enabled()[0];
      if (first) first.focus({ preventScroll: true });
    }
    function closeMenu(restore) {
      if (!menu) return;
      const m = menu;
      menu = null;
      doc.removeEventListener("pointerdown", m.outside, true);
      m.el.remove();
      if (m.opener && m.opener.setAttribute && m.opener.classList.contains("sg-menu-btn")) m.opener.setAttribute("aria-expanded", "false");
      if (restore) {
        if (m.opener && m.opener.isConnected) m.opener.focus({ preventScroll: true });
        else rootEl.focus({ preventScroll: true });
      }
    }
    function nodeMenuItems(id) {
      const n = getNode(id);
      if (!n) return [];
      if (!sel.has(id)) setSelection([id]);
      const ids = targetIds(id);
      const single = ids.length === 1;
      const d = defOf(n);
      const mode = n.mode || "normal";
      const items = [];
      if (opts.onOpenNode) items.push({ label: "開啟設定", key: "Enter", run: function () { opts.onOpenNode(id); } });
      if (single && !readOnly) items.push({ label: "重新命名", key: "F2", run: function () { renameNode(id); } });
      if (single && opts.onOpenNode && !readOnly && d && !d.virtual) items.push({ label: "重試設定…", run: function () { opts.onOpenNode(id); } });
      if (!readOnly) {
        items.push({ sep: true });
        items.push({ label: "正常", checked: single ? mode === "normal" : null, run: function () { setModes(ids, "normal"); } });
        items.push({ label: "略過", key: "Ctrl+B", aria: "Control+B", checked: single ? mode === "bypass" : null, run: function () { setModes(ids, "bypass"); } });
        items.push({ label: "停用", key: "Ctrl+M", aria: "Control+M", checked: single ? mode === "mute" : null, run: function () { setModes(ids, "mute"); } });
        items.push({ label: n.collapsed ? "展開" : "摺疊", run: function () { setCollapsed(ids, !n.collapsed); } });
        if (single && d && d.widgets) {
          const conv = n.converted || [];
          const cw = d.widgets.filter(function (w) { return w.convertible; });
          if (cw.length) items.push({ sep: true });
          cw.forEach(function (w) {
            const isIn = conv.indexOf(w.name) >= 0;
            items.push({ label: (isIn ? "轉回元件：" : "轉為輸入：") + (w.label || w.name), run: function () { convert(id, w, !isIn); } });
          });
        }
        items.push({ sep: true });
      }
      items.push({ label: "複製", key: "Ctrl+C", aria: "Control+C", run: function () { copySel(ids); } });
      if (!readOnly) {
        items.push({ label: "再製一份", run: function () { duplicate(ids); } });
        items.push({ label: "建立群組", key: "Ctrl+G", aria: "Control+G", run: groupSelection });
        items.push({ sep: true });
        items.push({ label: single ? "刪除" : "刪除 " + ids.length + " 個節點", key: "Delete", danger: true, run: function () { removeNodes(ids); } });
      }
      return items;
    }
    function canvasMenuItems(wpt) {
      return [
        !readOnly && { label: "新增節點…", key: "/", run: function () { openSearchWorld(wpt.x, wpt.y); } },
        !readOnly && { label: "貼上", key: "Ctrl+V", aria: "Control+V", disabled: !SG.__canvasClip, run: function () { pasteAt(wpt); } },
        { sep: true },
        { label: "全選", key: "Ctrl+A", aria: "Control+A", run: function () { setSelection(nodes().map(function (n) { return n.id; })); status("已選取全部 " + sel.size + " 個節點。"); } },
        { label: "符合畫面", key: "F", run: function () { fit(); status("已縮放至符合畫面。"); } },
        { label: "重設縮放", key: "0", run: function () { zoomTo(1); status("縮放 100%。"); } },
        !readOnly && sel.size && { label: "建立群組", key: "Ctrl+G", aria: "Control+G", run: groupSelection }
      ];
    }
    function linkMenuItems(linkId, wpt) {
      if (readOnly) return [];
      return [
        { label: "刪除連線", key: "Delete", danger: true, run: function () { mutate(function () { graph.disconnect(linkId); }); status("已移除連線。"); } },
        { label: "插入轉接點", run: function () { insertReroute(linkId, wpt); } }
      ];
    }
    function groupMenuItems(gid) {
      const g = groups().find(function (x) { return x.id === gid; });
      if (!g) return [];
      return [
        { label: "選取群組內節點", run: function () { const ids = nodesInGroup(g); setSelection(ids); status("已選取 " + ids.length + " 個節點。"); } },
        !readOnly && { label: "重新命名群組", run: function () { renameGroup(gid); } },
        !readOnly && { label: "刪除群組（保留節點）", danger: true, run: function () { mutate(function () { graph.removeGroup(gid); }); status("已刪除群組。"); rootEl.focus({ preventScroll: true }); } }
      ];
    }
    function portMenuItems(port) {
      if (readOnly) return [];
      return [{ label: "中斷此插槽的連線", key: "Delete", run: function () { disconnectPort(port); } }];
    }

    // ---------- search ----------
    function openSearchWorld(wx, wy, src) {
      if (readOnly) return;
      if (!SG.Search || typeof SG.Search.open !== "function") { status("節點搜尋尚未載入。"); return; }
      if (wx == null || wy == null) { const c = viewCenterWorld(); wx = c.x - 100; wy = c.y - 40; }
      const c = toClient(wx, wy);
      closeMenu(false);
      let filterType = null, filterDir = null, title = "搜尋節點";
      if (src) {
        const s = findSlot(src.id, src.dir, src.slot);
        filterType = s ? s.type : null;
        filterDir = src.dir === "out" ? "in" : "out";
        if (filterType) title = (src.dir === "out" ? "可接收「" : "可輸出「") + typeInfo(filterType).label + "」的節點";
      }
      let picked = false;
      searchPop = SG.Search.open({
        registry: registry, types: types, x: c.x, y: c.y, container: rootEl,
        filterType: filterType, filterDir: filterDir, title: title,
        onPick: function (type) { picked = true; addAt(type, wx, wy, src || null); },
        onClose: function () {
          searchPop = null;
          if (!picked) { rootEl.focus({ preventScroll: true }); status("已關閉節點搜尋。"); }
        }
      });
      status(title + "：輸入文字篩選，方向鍵選擇，Enter 加入。");
    }

    // ---------- pointer gestures ----------
    function bindGesture() {
      win.addEventListener("pointermove", onGestureMove);
      win.addEventListener("pointerup", onGestureUp);
      win.addEventListener("pointercancel", onGestureCancel);
    }
    function unbindGesture() {
      win.removeEventListener("pointermove", onGestureMove);
      win.removeEventListener("pointerup", onGestureUp);
      win.removeEventListener("pointercancel", onGestureCancel);
    }
    function startGesture(g) {
      if (gesture) endGesture();
      gesture = Object.assign({ started: false, dx: 0, dy: 0 }, g);
      bindGesture();
    }
    function endGesture() {
      unbindGesture();
      const g = gesture;
      gesture = null;
      rootEl.classList.remove("sg-panning");
      boxEl.hidden = true;
      return g;
    }

    function onPointerDown(e) {
      if (destroyed) return;
      usingPointer = true;
      const t = e.target;
      const isTouch = e.pointerType === "touch";
      if (isTouch) trackTouch(e);
      if (t.closest(".sg-menu, .sg-pop, .sg-minimap, .sg-rename, .sg-controls, .sg-empty")) return;
      lastPointer = { cx: e.clientX, cy: e.clientY };
      // second finger: switch whatever is going on into a pinch-zoom
      if (isTouch && touches.size >= 2) { startPinch(); return; }
      const empty = isEmptyTarget(t);
      // touch: one finger on empty canvas pans (mouse keeps box-select semantics)
      if (e.button === 1 || (e.button === 0 && (spaceHeld || (e.altKey && empty) || (isTouch && empty && !pending)))) {
        e.preventDefault();
        rootEl.focus({ preventScroll: true });
        startGesture({ kind: "pan", pid: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
        rootEl.classList.add("sg-panning");
        return;
      }
      if (e.button !== 0) return;
      if (isEditable(t) || t.closest(".sg-preview, .sg-approval, .sg-raw")) return;
      const port = t.closest(".sg-port");
      if (port) {
        if (readOnly) return;
        startGesture({ kind: "port", sx: e.clientX, sy: e.clientY, port: port, info: portInfo(port) });
        return;
      }
      if (t.closest(".sg-menu-btn, .sg-collapse-btn, .sg-pv-toggle")) return;
      const gres = t.closest(".sg-gresize");
      if (gres && !readOnly) {
        e.preventDefault();
        const gid = gres.parentNode.dataset.group;
        const g = groups().find(function (x) { return x.id === gid; });
        if (g) startGesture({ kind: "gresize", gid: gid, sx: e.clientX, sy: e.clientY, w0: g.w, h0: g.h, w: g.w, h: g.h });
        return;
      }
      const gt = t.closest(".sg-gtitle");
      if (gt) {
        const gid = gt.parentNode.dataset.group;
        const g = groups().find(function (x) { return x.id === gid; });
        if (g) {
          const ids = nodesInGroup(g);
          startGesture({ kind: "group", gid: gid, sx: e.clientX, sy: e.clientY, ids: ids, moving: new Set(ids) });
        }
        return;
      }
      const nEl = t.closest(".sg-node");
      if (nEl) {
        const id = nEl.dataset.node;
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          if (sel.has(id)) sel.delete(id); else sel.add(id);
          selLink = null;
          applySelection(); notifySelect();
          status(sel.has(id) ? "已加入選取，共 " + sel.size + " 個節點。" : "已取消選取，共 " + sel.size + " 個節點。");
          if (!sel.has(id)) return;
        } else if (!sel.has(id)) {
          setSelection([id]);
        }
        if (selLink) { selLink = null; applySelection(); }
        if (!t.closest("button")) { e.preventDefault(); nEl.querySelector(".sg-title").focus({ preventScroll: true }); }
        if (!readOnly) startGesture({ kind: "move", sx: e.clientX, sy: e.clientY, ids: Array.from(sel), lead: id });
        return;
      }
      const wire = t.closest("[data-link]");
      if (wire) {
        e.preventDefault();
        rootEl.focus({ preventScroll: true });
        selectLink(wire.dataset.link);
        return;
      }
      // empty canvas
      e.preventDefault();
      rootEl.focus({ preventScroll: true });
      if (pending) { cancelPending(true); return; }
      startGesture({ kind: "box", sx: e.clientX, sy: e.clientY, additive: e.shiftKey || e.ctrlKey || e.metaKey, base: new Set(e.shiftKey || e.ctrlKey || e.metaKey ? sel : []) });
    }

    // ---------- touch: pinch zoom ----------
    function trackTouch(e) {
      const first = touches.size === 0;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (first) {
        win.addEventListener("pointermove", onTouchMove);
        win.addEventListener("pointerup", onTouchEnd);
        win.addEventListener("pointercancel", onTouchEnd);
      }
    }
    function untrackTouches() {
      touches.clear();
      win.removeEventListener("pointermove", onTouchMove);
      win.removeEventListener("pointerup", onTouchEnd);
      win.removeEventListener("pointercancel", onTouchEnd);
    }
    function touchPair() {
      const pts = Array.from(touches.values()).slice(0, 2);
      return { d: Math.max(1, Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)), x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    }
    function startPinch() {
      if (gesture) {
        // abandon an in-progress one-finger gesture without committing it
        const old = endGesture();
        if (old && old.kind === "port" && old.started) cancelPending(false);
        scheduleRender();
      }
      const p = touchPair(), r = rect();
      gesture = { kind: "pinch", started: true, d0: p.d, k0: view.k, wx: (p.x - r.left - view.x) / view.k, wy: (p.y - r.top - view.y) / view.k };
      rootEl.classList.add("sg-panning");
    }
    function onTouchMove(e) {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = gesture;
      if (!g || g.kind !== "pinch" || touches.size < 2) return;
      const p = touchPair(), r = rect();
      const k = clamp(g.k0 * p.d / g.d0, MIN_K, MAX_K);
      setViewLocal({ x: p.x - r.left - g.wx * k, y: p.y - r.top - g.wy * k, k: k }, false);
    }
    function onTouchEnd(e) {
      if (!touches.has(e.pointerId)) return;
      touches.delete(e.pointerId);
      if (gesture && gesture.kind === "pinch" && touches.size < 2) {
        gesture = null;
        rootEl.classList.remove("sg-panning");
        pushView();
        status("縮放 " + Math.round(view.k * 100) + "%。");
      }
      if (!touches.size) untrackTouches();
    }

    function onGestureMove(e) {
      const g = gesture;
      if (!g) return;
      if (g.kind === "pinch" || (g.pid != null && e.pointerId !== g.pid)) return;
      lastPointer = { cx: e.clientX, cy: e.clientY };
      const ddx = e.clientX - g.sx, ddy = e.clientY - g.sy;
      if (!g.started) {
        if (Math.hypot(ddx, ddy) < (g.kind === "port" ? 5 : 3)) return;
        g.started = true;
        if (g.kind === "port") beginPortDrag(g);
      }
      const k = view.k;
      if (g.kind === "pan") {
        setViewLocal({ x: g.vx + ddx, y: g.vy + ddy, k: k }, false);
      } else if (g.kind === "move" || g.kind === "group") {
        let dx = ddx / k, dy = ddy / k;
        const ref = g.kind === "move" ? getNode(g.lead) : groups().find(function (x) { return x.id === g.gid; });
        if (snap && ref) {
          dx = Math.round((ref.x + dx) / snap) * snap - ref.x;
          dy = Math.round((ref.y + dy) / snap) * snap - ref.y;
        }
        g.dx = Math.round(dx); g.dy = Math.round(dy);
        if (!g.moving) g.moving = new Set(g.ids);
        g.moving.forEach(function (id) {
          const n = getNode(id), rec = nodeEls.get(id);
          if (!n || !rec) return;
          rec.el.style.left = (n.x + g.dx) + "px"; rec.el.style.top = (n.y + g.dy) + "px";
          rec.last.x = n.x + g.dx; rec.last.y = n.y + g.dy;
        });
        if (g.kind === "group") {
          const gr = groups().find(function (x) { return x.id === g.gid; }), rec = groupEls.get(g.gid);
          if (gr && rec) { rec.el.style.left = (gr.x + g.dx) + "px"; rec.el.style.top = (gr.y + g.dy) + "px"; }
        }
        scheduleWires();
      } else if (g.kind === "gresize") {
        g.w = Math.max(120, Math.round(g.w0 + ddx / k));
        g.h = Math.max(80, Math.round(g.h0 + ddy / k));
        if (snap) { g.w = Math.round(g.w / snap) * snap; g.h = Math.round(g.h / snap) * snap; }
        const rec = groupEls.get(g.gid);
        if (rec) { rec.el.style.width = g.w + "px"; rec.el.style.height = g.h + "px"; }
        emit("move");
      } else if (g.kind === "box") {
        const r = rect();
        const x1 = Math.min(g.sx, e.clientX) - r.left, y1 = Math.min(g.sy, e.clientY) - r.top;
        const w = Math.abs(ddx), h = Math.abs(ddy);
        boxEl.hidden = false;
        boxEl.style.left = x1 + "px"; boxEl.style.top = y1 + "px";
        boxEl.style.width = w + "px"; boxEl.style.height = h + "px";
        const a = toWorld(Math.min(g.sx, e.clientX), Math.min(g.sy, e.clientY));
        const b = toWorld(Math.max(g.sx, e.clientX), Math.max(g.sy, e.clientY));
        sel.clear();
        g.base.forEach(function (id) { sel.add(id); });
        nodes().forEach(function (n) {
          const s = nodeSize(n.id);
          if (n.x < b.x && n.x + s.w > a.x && n.y < b.y && n.y + s.h > a.y) sel.add(n.id);
        });
        applySelection();
      } else if (g.kind === "port") {
        drawGhostTo(toWorld(e.clientX, e.clientY));
      }
    }

    function beginPortDrag(g) {
      suppressClickAt = Date.now();
      const p = g.info;
      if (p.dir === "in") {
        const existing = links().find(function (l) { return l.to === p.id && l.in === p.slot; });
        if (existing) {
          g.detach = existing.id;
          g.origin = p;
          setPending({ id: existing.from, dir: "out", slot: existing.out });
          drawWires();
          return;
        }
      }
      setPending({ id: p.id, dir: p.dir, slot: p.slot });
    }

    function onGestureUp(e) {
      const g = gesture;
      if (!g) return;
      if (g.pid != null && e.pointerId !== g.pid) return;
      if (g.kind === "port" && g.started) { finishPortDrag(g, e); endGesture(); drawWires(); return; }
      endGesture();
      if (g.kind === "pan") { pushView(); return; }
      if (g.kind === "move" || g.kind === "group") {
        if (g.started && (g.dx || g.dy)) {
          const ids = g.ids.filter(function (id) { return !!getNode(id); });
          const dx = g.dx, dy = g.dy;
          if (g.kind === "group") {
            const gr = groups().find(function (x) { return x.id === g.gid; });
            mutate(function () {
              if (ids.length) graph.moveNodes(ids, dx, dy);
              if (gr) graph.updateGroup(g.gid, { x: gr.x + dx, y: gr.y + dy });
            });
            status("已移動群組" + (ids.length ? "與 " + ids.length + " 個節點" : "") + "。");
          } else {
            mutate(function () { graph.moveNodes(ids, dx, dy); });
            status("已移動 " + ids.length + " 個節點。");
          }
        } else if (g.kind === "group" && !g.started) {
          setSelection(g.ids);
          status("已選取群組內 " + g.ids.length + " 個節點。");
        }
        scheduleRender();
        return;
      }
      if (g.kind === "gresize") {
        if (g.started) {
          mutate(function () { graph.updateGroup(g.gid, { w: g.w, h: g.h }); });
          status("已調整群組大小。");
        }
        scheduleRender();
        return;
      }
      if (g.kind === "box") {
        if (!g.started) {
          if (!g.additive) {
            const had = sel.size || selLink;
            sel.clear(); selLink = null; applySelection();
            if (had) { notifySelect(); status("已取消選取。"); }
          }
        } else {
          notifySelect();
          status("已選取 " + sel.size + " 個節點。");
        }
      }
    }

    function onGestureCancel(e) {
      if (e && e.pointerId != null && gesture && gesture.pid != null && e.pointerId !== gesture.pid) return;
      const g = endGesture();
      if (g && g.kind === "port" && g.started) cancelPending(false);
      scheduleRender();
    }

    function finishPortDrag(g, e) {
      const src = pending;
      const el = doc.elementFromPoint(e.clientX, e.clientY);
      const wpt = toWorld(e.clientX, e.clientY);
      cancelPending(false);
      if (!src) return;
      const wantDir = src.dir === "out" ? "in" : "out";
      let target = null;
      if (el && rootEl.contains(el)) {
        const port = el.closest(".sg-port");
        const nEl = el.closest(".sg-node");
        if (port && port.dataset.dir === wantDir) target = portInfo(port);
        else if (nEl && !port) {
          const nid = nEl.dataset.node;
          const slot = firstCompatible(nid, wantDir, src);
          if (slot) target = { id: nid, slot: slot };
          else { status("「" + labelFor(nid) + "」沒有相容的" + (wantDir === "in" ? "輸入" : "輸出") + "。"); return; }
        } else if (isEmptyTarget(el) || el.closest("[data-link]")) {
          if (g.detach) {
            mutate(function () { graph.disconnect(g.detach); });
            status("已移除連線。");
          } else {
            openSearchWorld(wpt.x, wpt.y, src);
          }
          return;
        }
      }
      if (!target) return;
      if (g.detach) {
        if (target.id === g.origin.id && target.slot === g.origin.slot) return;
        const r = cc(src.id, src.slot, target.id, target.slot);
        if (!r.ok) { status("無法連線：" + (r.reason || "型別不相容")); return; }
        let link = null;
        mutate(function () { graph.disconnect(g.detach); link = graph.connect(src.id, src.slot, target.id, target.slot); });
        status(link ? "已改接到「" + labelFor(target.id) + "」．" + slotLabel(target.id, "in", target.slot) + "。" : "無法連線。");
        return;
      }
      if (src.dir === "out") tryConnect(src.id, src.slot, target.id, target.slot);
      else tryConnect(target.id, target.slot, src.id, src.slot);
    }

    function onHoverMove(e) {
      pointerInside = true;
      lastPointer = { cx: e.clientX, cy: e.clientY };
      if (pending && !gesture) drawGhostTo(toWorld(e.clientX, e.clientY));
    }

    function onClick(e) {
      const t = e.target;
      if (Date.now() - suppressClickAt < 400 && t.closest(".sg-port")) { suppressClickAt = 0; e.preventDefault(); return; }
      const port = t.closest(".sg-port");
      if (port) { portClick(port); return; }
      const ap = t.closest(".sg-approve, .sg-reject");
      if (ap) {
        const id = ap.closest(".sg-node").dataset.node;
        const ok = ap.classList.contains("sg-approve");
        status((ok ? "已核准「" : "已拒絕「") + labelFor(id) + "」。");
        if (opts.onApprove) { try { opts.onApprove(id, ok); } catch (err) { status("核准處理失敗：" + err.message); } }
        else status("尚未設定核准處理。");
        return;
      }
      const mb = t.closest(".sg-menu-btn");
      if (mb) {
        const id = mb.closest(".sg-node").dataset.node;
        const r = mb.getBoundingClientRect();
        openMenu(nodeMenuItems(id), r.left, r.bottom + 2, mb, labels.menu);
        return;
      }
      const pvt = t.closest(".sg-pv-toggle");
      if (pvt) { togglePreview(pvt.closest(".sg-node").dataset.node); return; }
      const cb = t.closest(".sg-collapse-btn");
      if (cb) {
        const id = cb.closest(".sg-node").dataset.node;
        toggleCollapse([id]);
        return;
      }
      const tb = t.closest(".sg-title");
      if (tb && e.detail === 0) {
        const id = tb.closest(".sg-node").dataset.node;
        if (e.shiftKey) { if (sel.has(id)) sel.delete(id); else sel.add(id); applySelection(); notifySelect(); }
        else setSelection([id]);
        if (opts.onOpenNode && !e.shiftKey) opts.onOpenNode(id);
        else status("已選取「" + labelFor(id) + "」。");
        return;
      }
      const gt = t.closest(".sg-gtitle");
      if (gt && e.detail === 0) {
        const g = groups().find(function (x) { return x.id === gt.parentNode.dataset.group; });
        if (g) { const ids = nodesInGroup(g); setSelection(ids); status("已選取群組內 " + ids.length + " 個節點。"); }
      }
    }

    function onDblClick(e) {
      const t = e.target;
      if (isEditable(t) || t.closest(".sg-menu, .sg-pop, .sg-minimap, .sg-preview, .sg-port, .sg-controls, .sg-empty button, .sg-pv-toggle")) return;
      const wire = t.closest("[data-link]");
      if (wire) { if (!readOnly) insertReroute(wire.dataset.link, toWorld(e.clientX, e.clientY)); return; }
      const gt = t.closest(".sg-gtitle");
      if (gt) { renameGroup(gt.parentNode.dataset.group); return; }
      const nEl = t.closest(".sg-node");
      if (nEl) {
        if (t.closest(".sg-head") && opts.onOpenNode) opts.onOpenNode(nEl.dataset.node);
        return;
      }
      if (isEmptyTarget(t)) {
        const w = toWorld(e.clientX, e.clientY);
        openSearchWorld(w.x, w.y);
      }
    }

    function onContextMenu(e) {
      const t = e.target;
      if (isEditable(t) || t.closest(".sg-pop, .sg-preview")) return;
      e.preventDefault();
      if (gesture || t.closest(".sg-controls, .sg-minimap")) return;
      const wpt = toWorld(e.clientX, e.clientY);
      const port = t.closest(".sg-port");
      if (port) { openMenu(portMenuItems(port), e.clientX, e.clientY, port, "插槽選單"); return; }
      const nEl = t.closest(".sg-node");
      if (nEl) { openMenu(nodeMenuItems(nEl.dataset.node), e.clientX, e.clientY, nEl.querySelector(".sg-menu-btn") || nEl.querySelector(".sg-title"), labels.menu); return; }
      const wire = t.closest("[data-link]");
      if (wire) { selectLink(wire.dataset.link); openMenu(linkMenuItems(wire.dataset.link, wpt), e.clientX, e.clientY, rootEl, "連線選單"); return; }
      const gEl = t.closest(".sg-gtitle");
      if (gEl) { openMenu(groupMenuItems(gEl.parentNode.dataset.group), e.clientX, e.clientY, gEl, "群組選單"); return; }
      openMenu(canvasMenuItems(wpt), e.clientX, e.clientY, rootEl, "畫布選單");
    }

    function onWheel(e) {
      if (e.target.closest(".sg-menu, .sg-pop")) return;
      const sc = e.target.closest("textarea, .sg-preview, .sg-raw");
      if (sc && !e.ctrlKey && sc.scrollHeight > sc.clientHeight + 1) return;
      e.preventDefault();
      let dy = e.deltaY, dx = e.deltaX;
      if (e.deltaMode === 1) { dy *= 16; dx *= 16; } else if (e.deltaMode === 2) { dy *= 400; dx *= 400; }
      if (!e.ctrlKey && Math.abs(dx) > Math.abs(dy)) {
        setViewLocal({ x: view.x - dx, y: view.y, k: view.k });
        return;
      }
      zoomAt(e.clientX, e.clientY, view.k * Math.exp(-dy * 0.0015));
    }

    // ---------- keyboard ----------
    function onKeyDown(e) {
      usingPointer = false;
      const t = e.target;
      if (t.closest && t.closest(".sg-menu, .sg-pop, .sg-rename")) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key;
      if (isEditable(t)) return;
      if (t.closest && t.closest(".sg-controls") && !mod && (key === "ArrowLeft" || key === "ArrowRight" || key === "Home" || key === "End")) {
        e.preventDefault();
        const list = Array.prototype.filter.call(controls.querySelectorAll("button"), function (b) { return !b.hidden; });
        const i = list.indexOf(t);
        const j = key === "Home" ? 0 : key === "End" ? list.length - 1 : (i + (key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
        if (list[j]) list[j].focus();
        return;
      }
      const inNode = t.closest && t.closest(".sg-node");
      const onButton = t.tagName === "BUTTON";
      if (key === " " && !onButton) {
        e.preventDefault();
        if (!spaceHeld) { spaceHeld = true; rootEl.classList.add("sg-grab"); }
        return;
      }
      if (key === "Escape") {
        if (gesture) { onGestureCancel(); e.preventDefault(); return; }
        if (menu) { closeMenu(true); e.preventDefault(); return; }
        if (pending) { cancelPending(true); e.preventDefault(); return; }
        if (selLink) { selLink = null; applySelection(); status("已取消選取連線。"); e.preventDefault(); return; }
        if (sel.size) { setSelection([]); status("已取消選取。"); e.preventDefault(); return; }
        return;
      }
      if (mod && key === "Enter") {
        e.preventDefault();
        if (opts.onRequestRun) opts.onRequestRun(); else status("尚未設定執行。");
        return;
      }
      if (mod) {
        const k = key.toLowerCase();
        let handled = true;
        if (k === "c") copySel();
        else if (k === "x") { if (!readOnly && copySel()) removeNodes(Array.from(sel)); }
        else if (k === "v") { if (!readOnly) pasteAt(); }
        else if (k === "z" && !e.shiftKey) undo();
        else if ((k === "z" && e.shiftKey) || k === "y") redo();
        else if (k === "a") { setSelection(nodes().map(function (n) { return n.id; })); status("已選取全部 " + sel.size + " 個節點。"); }
        else if (k === "b") { if (!readOnly) setModes(Array.from(sel), "bypass"); }
        else if (k === "m") { if (!readOnly) setModes(Array.from(sel), "mute"); }
        else if (k === "g") { if (!readOnly) groupSelection(); }
        else handled = false;
        if (handled) e.preventDefault();
        return;
      }
      if (e.altKey) return;
      if (key === "Delete" || key === "Backspace") {
        if (readOnly) return;
        e.preventDefault();
        if (t.classList && t.classList.contains("sg-port")) disconnectPort(t);
        else removeSelected();
        return;
      }
      if (key === "+" || key === "=") { e.preventDefault(); zoomTo(view.k * 1.2); status("縮放 " + Math.round(view.k * 100) + "%。"); return; }
      if (key === "-" || key === "_") { e.preventDefault(); zoomTo(view.k / 1.2); status("縮放 " + Math.round(view.k * 100) + "%。"); return; }
      if (key === "0") { e.preventDefault(); zoomTo(1); status("縮放 100%。"); return; }
      if (key === "f" || key === "F" || key === ".") { e.preventDefault(); fit(); status("已縮放至符合畫面。"); return; }
      if (key === "/" && !readOnly) { e.preventDefault(); openSearchWorld(); return; }
      if (key === "F2" && inNode && !readOnly) { e.preventDefault(); renameNode(inNode.dataset.node); return; }
      if ((key === "ContextMenu" || (key === "F10" && e.shiftKey)) && inNode) {
        e.preventDefault();
        const mb = inNode.querySelector(".sg-menu-btn") || t;
        const r = mb.getBoundingClientRect();
        openMenu(nodeMenuItems(inNode.dataset.node), r.left, r.bottom + 2, mb, labels.menu);
        return;
      }
      const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[key]) {
        e.preventDefault();
        const v = arrows[key];
        if (inNode && !readOnly) {
          const id = inNode.dataset.node;
          if (!sel.has(id)) setSelection([id]);
          const step = (snap || 10) * (e.shiftKey ? 5 : 1);
          const ids = Array.from(sel);
          mutate(function () { graph.moveNodes(ids, v[0] * step, v[1] * step); });
          const n = getNode(id);
          status("已移動 " + ids.length + " 個節點" + (n ? "（" + Math.round(n.x) + ", " + Math.round(n.y) + "）" : "") + "。");
          raf(function () { ensureVisible(id); });
        } else {
          const step = 40 * (e.shiftKey ? 5 : 1);
          setViewLocal({ x: view.x - v[0] * step, y: view.y - v[1] * step, k: view.k });
        }
      }
    }
    function onKeyUp(e) {
      if (e.key === " ") { spaceHeld = false; rootEl.classList.remove("sg-grab"); }
    }
    function onWinBlur() { spaceHeld = false; rootEl.classList.remove("sg-grab"); }

    function onFocusIn(e) {
      if (usingPointer) return;
      const nEl = e.target.closest && e.target.closest(".sg-node");
      if (nEl) ensureVisible(nEl.dataset.node);
    }
    function onScroll() { if (rootEl.scrollLeft || rootEl.scrollTop) { rootEl.scrollLeft = 0; rootEl.scrollTop = 0; } }

    // ---------- native drop ----------
    function hasMime(e) {
      const dt = e.dataTransfer;
      return !!dt && Array.prototype.indexOf.call(dt.types || [], MIME) >= 0;
    }
    function onDragOver(e) {
      if (!hasMime(e) || readOnly) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      rootEl.classList.add("sg-drop-hot");
    }
    function onDragLeave(e) {
      if (!e.relatedTarget || !rootEl.contains(e.relatedTarget)) rootEl.classList.remove("sg-drop-hot");
    }
    function onDrop(e) {
      rootEl.classList.remove("sg-drop-hot");
      if (!hasMime(e) || readOnly) return;
      e.preventDefault();
      e.stopPropagation();
      const type = e.dataTransfer.getData(MIME);
      if (!type) return;
      const p = toWorld(e.clientX, e.clientY);
      const x = Math.round(p.x), y = Math.round(p.y);
      if (opts.onDropType) opts.onDropType(type, x, y);
      else addAt(type, x, y);
      rootEl.focus({ preventScroll: true });
    }

    // ---------- wire up ----------
    rootEl.addEventListener("pointerdown", onPointerDown);
    rootEl.addEventListener("pointermove", onHoverMove);
    rootEl.addEventListener("pointerleave", function () { pointerInside = false; });
    rootEl.addEventListener("click", onClick);
    rootEl.addEventListener("dblclick", onDblClick);
    rootEl.addEventListener("contextmenu", onContextMenu);
    rootEl.addEventListener("auxclick", function (e) { if (e.button === 1) e.preventDefault(); });
    rootEl.addEventListener("wheel", onWheel, { passive: false });
    rootEl.addEventListener("keydown", onKeyDown);
    rootEl.addEventListener("keyup", onKeyUp);
    rootEl.addEventListener("focusin", onFocusIn);
    rootEl.addEventListener("scroll", onScroll);
    rootEl.addEventListener("dragover", onDragOver);
    rootEl.addEventListener("dragleave", onDragLeave);
    rootEl.addEventListener("drop", onDrop);
    win.addEventListener("blur", onWinBlur);

    // ---------- floating controls / minimap toggle ----------
    function zoomStep(f) {
      zoomTo(view.k * f);
      status("縮放 " + Math.round(view.k * 100) + "%。");
    }
    zoomOutBtn.addEventListener("click", function () { if (view.k > MIN_K + 1e-6) zoomStep(1 / 1.2); });
    zoomInBtn.addEventListener("click", function () { if (view.k < MAX_K - 1e-6) zoomStep(1.2); });
    zoomBtn.addEventListener("click", function () { zoomTo(1); status("縮放 100%。"); });
    fitBtn.addEventListener("click", function () { fit(); status("已縮放至符合畫面。"); });
    mmBtn.addEventListener("click", function () {
      setMinimap(!minimapOn, true);
      status(minimapOn ? "已顯示小地圖。" : "已隱藏小地圖。");
    });
    emptyBtn.addEventListener("click", function () { openSearchWorld(); });

    function readMinimapPref() {
      try { const v = win.localStorage.getItem(MINIMAP_KEY); return v === "1" ? true : v === "0" ? false : null; }
      catch (e) { return null; }
    }
    function setMinimap(on, byUser) {
      on = !!on && !!minimap;
      minimapOn = on;
      if (minimap) minimap.setVisible(on);
      mmBtn.setAttribute("aria-pressed", on ? "true" : "false");
      if (byUser) {
        minimapAuto = false;
        try { win.localStorage.setItem(MINIMAP_KEY, on ? "1" : "0"); } catch (e) { /* storage unavailable */ }
      }
      emit("minimap", on);
    }
    function onResize() {
      if (destroyed) return;
      const w = rootEl.clientWidth;
      if (minimapAuto && w > 0) {
        const want = w >= MINIMAP_MIN_W;
        if (want !== minimapOn) setMinimap(want, false);
      }
      emit("resize", { w: w, h: rootEl.clientHeight });
    }

    const offChange = graph.on("change", function (ev) {
      slotsCache.clear();
      scheduleRender(!!ev && ev.reason === "view");
    });

    // ---------- public API ----------
    const api = {
      setNodeState: function (id, st) {
        if (!st || (st.status === "idle" && st.preview == null && !st.message)) states.delete(id);
        else states.set(id, Object.assign({}, st));
        const n = getNode(id), rec = nodeEls.get(id);
        if (n && rec) {
          applyState(n, rec);
          const h = rec.size.h;
          measure(rec);
          if (rec.size.h !== h) scheduleWires();
        }
        emit("state", { id: id, state: st });
      },
      setLinkState: function (linkId, st) {
        if (!st || !st.inactive) linkStates.delete(linkId);
        else linkStates.set(linkId, Object.assign({}, st));
        scheduleWires();
      },
      clearStates: function () {
        states.clear();
        linkStates.clear();
        scheduleWires();
        nodeEls.forEach(function (rec, id) { const n = getNode(id); if (n) applyState(n, rec); });
        emit("state", null);
      },
      getState: function (id) { return states.get(id) || { status: "idle" }; },
      fit: fit,
      zoomTo: function (k) { zoomTo(k); },
      centerOn: centerOn,
      select: function (ids) { setSelection(Array.isArray(ids) ? ids : ids ? [ids] : []); },
      selection: function () { return Array.from(sel); },
      toWorld: toWorld,
      toClient: toClient,
      openSearch: function (x, y) { openSearchWorld(x, y); },
      focus: function () { rootEl.focus({ preventScroll: true }); },
      destroy: function () {
        if (destroyed) return;
        emit("destroy");
        destroyed = true;
        if (viewTimer) { clearTimeout(viewTimer); viewTimer = 0; try { graph.setView && graph.setView(getView()); } catch (e) { /* ignore */ } }
        unbindGesture();
        untrackTouches();
        if (resizeObs) { try { resizeObs.disconnect(); } catch (e) { /* ignore */ } resizeObs = null; }
        win.removeEventListener("resize", onResize);
        closeMenu(false);
        if (searchPop && searchPop.close) searchPop.close();
        if (minimap && minimap.destroy) minimap.destroy();
        win.removeEventListener("blur", onWinBlur);
        if (typeof offChange === "function") offChange();
        rootEl.remove();
      },
      // extras (beyond the contract, used by minimap / app helpers)
      graph: graph,
      root: rootEl,
      getView: getView,
      setView: function (v) { setViewLocal(Object.assign(getView(), v || {})); },
      viewportSize: function () { return { w: rootEl.clientWidth, h: rootEl.clientHeight }; },
      nodeRects: function () {
        return nodes().map(function (n) {
          const p = visualPos(n), s = nodeSize(n.id), st = states.get(n.id);
          return { id: n.id, x: p.x, y: p.y, w: s.w, h: s.h, selected: sel.has(n.id), mode: n.mode || "normal", status: st ? st.status : "idle", missing: !!n.missing || !defOf(n) };
        });
      },
      groupRects: function () { return groups().map(function (g) { return { id: g.id, x: g.x, y: g.y, w: g.w, h: g.h, color: g.color || GROUP_COLORS[0] }; }); },
      on: on,
      setSnap: function (n) { snap = Math.max(0, Number(n) || 0); },
      redraw: function () { scheduleRender(); },
      // Minimap visibility (also driven by the 小地圖 button). setMinimap(on) persists the choice in
      // localStorage "sea-agent-studio-v06.ui.minimap" like a user toggle; omit `on` to toggle.
      setMinimap: function (on) { setMinimap(on == null ? !minimapOn : on, true); },
      minimapVisible: function () { return minimapOn; },
      // Screen-space rects (relative to the canvas) the app should avoid covering with its own overlays.
      overlayRects: function () {
        const r = rect();
        return [controls, minimapOn && minimap ? minimap.el : null].filter(function (el) { return el && !el.hidden; }).map(function (el) {
          const b = el.getBoundingClientRect();
          return { x: b.left - r.left, y: b.top - r.top, w: b.width, h: b.height };
        });
      }
    };

    applyView();
    renderFull = true;
    render();
    if (opts.minimap !== false && SG.Minimap && typeof SG.Minimap.mount === "function") {
      try { minimap = SG.Minimap.mount(api, rootEl); } catch (e) { minimap = null; }
    }
    if (!minimap) mmBtn.hidden = true;
    else {
      const pref = readMinimapPref();
      if (pref != null) { minimapAuto = false; setMinimap(pref, false); }
      else setMinimap((rootEl.clientWidth || 0) >= MINIMAP_MIN_W, false);
    }
    if (typeof win.ResizeObserver === "function") {
      resizeObs = new win.ResizeObserver(function () { onResize(); });
      resizeObs.observe(rootEl);
    } else {
      win.addEventListener("resize", onResize);
    }
    return api;
  }

  SG.Canvas = { mount: mount, MIME: MIME, MIN_ZOOM: MIN_K, MAX_ZOOM: MAX_K };
})(globalThis);
