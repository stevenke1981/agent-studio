/* Contract-shaped stand-in for SG.types / SG.registry / SG.Graph (docs/comfy-plan.md).
 * DEV ONLY — loaded by comfy/dev/canvas-demo.html, never by the app.
 * Every piece is guarded: if the real engine is already loaded, it is left untouched.
 */
(function (root) {
  const SG = root.SeaGraph = root.SeaGraph || {};

  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  // ---------------- types ----------------
  if (!SG.types) {
    const defs = new Map();
    SG.types = {
      define: function (id, d) { defs.set(id, Object.assign({ id: id, label: id, color: "#8cb7ea" }, d || {}, { id: id })); return defs.get(id); },
      get: function (id) { return defs.get(id) || { id: id, label: id === "*" ? "任意" : String(id), color: id === "*" ? "#9aa5b1" : "#8cb7ea" }; },
      compatible: function (a, b) {
        if (a === b || a === "*" || b === "*") return true;
        const d = defs.get(b);
        return !!(d && d.accepts && (d.accepts.indexOf(a) >= 0 || d.accepts.indexOf("*") >= 0));
      },
      list: function () { return Array.from(defs.values()); }
    };
  }
  [
    ["*", "任意", "#9aa5b1"], ["STRING", "文字", "#8cb7ea"], ["NUMBER", "數字", "#e6b450"],
    ["BOOLEAN", "布林", "#f07178"], ["QUERY", "查詢", "#7fd1b9"], ["SOURCES", "來源", "#c792ea"],
    ["SUMMARY", "摘要", "#f78c6c", ["STRING"]], ["REPORT", "報告", "#ffcb6b"], ["LOOP", "迴圈", "#d9b866"]
  ].forEach(function (t) {
    if (SG.types.list && SG.types.list().some(function (x) { return x.id === t[0]; })) return;
    SG.types.define(t[0], { label: t[1], color: t[2], accepts: t[3] });
  });

  // ---------------- registry ----------------
  if (!SG.registry) {
    const reg = new Map();
    SG.registry = {
      register: function (def) { reg.set(def.type, def); return def; },
      get: function (type) { return reg.get(type) || null; },
      list: function () { return Array.from(reg.values()); },
      search: function (text) {
        const q = String(text || "").toLowerCase();
        return Array.from(reg.values()).filter(function (d) { return [d.title, d.type, d.category, d.hint].join(" ").toLowerCase().indexOf(q) >= 0; });
      },
      unregister: function (type) { reg.delete(type); }
    };
  }
  if (!SG.CycleError) {
    SG.CycleError = function CycleError(msg) { const e = new Error(msg || "發現循環"); e.name = "CycleError"; return e; };
  }

  const condWidgets = [
    { name: "mode", kind: "select", label: "判斷", default: "contains",
      options: [{ value: "nonempty", label: "非空" }, { value: "contains", label: "包含文字" }, { value: "equals", label: "等於" }, { value: "regex", label: "符合規則" }, { value: "truthy", label: "為真" }] },
    { name: "pattern", kind: "text", label: "文字", default: "Rust", convertible: true, type: "STRING" },
    { name: "negate", kind: "toggle", label: "反向", default: false }
  ];
  const demoTypes = [
    { type: "demo/text", title: "文字", category: "輸入", hint: "一段固定文字",
      inputs: [], outputs: [{ name: "text", type: "STRING", label: "文字" }],
      widgets: [{ name: "text", kind: "text", label: "內容", default: "Rust 測試", maxLength: 200, convertible: true, type: "STRING" }] },
    { type: "demo/number", title: "數字", category: "輸入", hint: "一個數值",
      inputs: [], outputs: [{ name: "value", type: "NUMBER", label: "數值" }],
      widgets: [{ name: "value", kind: "number", label: "數值", default: 5, min: 0, max: 100, step: 1 }] },
    { type: "demo/query", title: "查詢", category: "搜尋", hint: "準備搜尋關鍵字",
      inputs: [], outputs: [{ name: "query", type: "QUERY", label: "查詢" }],
      widgets: [
        { name: "query", kind: "text", label: "查詢詞", default: "Rust 測試", maxLength: 220, convertible: true, type: "STRING" },
        { name: "lang", kind: "select", label: "語言", default: "zh", options: [{ value: "zh", label: "中文" }, { value: "en", label: "英文" }] }
      ] },
    { type: "demo/search", title: "搜尋文件", category: "搜尋", hint: "在本機索引找官方文件",
      inputs: [{ name: "query", type: "QUERY", label: "查詢" }],
      outputs: [{ name: "sources", type: "SOURCES", label: "來源" }, { name: "count", type: "NUMBER", label: "筆數" }],
      widgets: [
        { name: "limit", kind: "number", label: "上限", default: 5, min: 1, max: 20, step: 1, convertible: true, type: "NUMBER" },
        { name: "official", kind: "toggle", label: "只要官方", default: true }
      ] },
    { type: "demo/summarize", title: "摘要", category: "整理", hint: "把來源整理成摘要",
      inputs: [{ name: "sources", type: "SOURCES", label: "來源" }, { name: "style", type: "STRING", label: "風格", optional: true }],
      outputs: [{ name: "summary", type: "SUMMARY", label: "摘要" }],
      widgets: [
        { name: "prompt", kind: "textarea", label: "指示", default: "條列重點，附上引用。" },
        { name: "tone", kind: "select", label: "語氣", default: "plain", options: [{ value: "plain", label: "平實" }, { value: "brief", label: "精簡" }, { value: "formal", label: "正式" }] }
      ] },
    { type: "demo/echo", title: "轉述", category: "整理", hint: "把任何值轉成文字",
      inputs: [{ name: "value", type: "*", label: "值" }], outputs: [{ name: "text", type: "STRING", label: "文字" }],
      widgets: [{ name: "prefix", kind: "text", label: "前綴", default: "" }] },
    { type: "demo/report", title: "報告", category: "輸出", hint: "產生最終報告", output: true,
      inputs: [{ name: "summary", type: "SUMMARY", label: "摘要" }, { name: "extra", type: "*", label: "附加", optional: true }],
      outputs: [{ name: "report", type: "REPORT", label: "報告" }],
      widgets: [
        { name: "title", kind: "text", label: "標題", default: "研究交接" },
        { name: "path", kind: "text", label: "輸出路徑（示範，不會寫入）", default: "docs/handoff.md" },
        { name: "include", kind: "toggle", label: "附上來源清單與引用（模擬）", default: true }
      ] },
    { type: "core/reroute", title: "轉接點", category: "核心", hint: "整理連線", virtual: true,
      inputs: [{ name: "value", type: "*", label: "值" }], outputs: [{ name: "value", type: "*", label: "值" }], widgets: [] },
    { type: "core/note", title: "備註", category: "核心", hint: "畫布上的說明文字", virtual: true,
      inputs: [], outputs: [], widgets: [{ name: "text", kind: "textarea", label: "備註", default: "在這裡寫下說明。" }] },
    { type: "core/approval", title: "人工核准", category: "流程", hint: "暫停等待核准", nocache: true,
      inputs: [{ name: "value", type: "*", label: "值" }], outputs: [{ name: "value", type: "*", label: "值" }],
      widgets: [{ name: "message", kind: "textarea", label: "提示", default: "請確認是否繼續" }, { name: "auto", kind: "toggle", label: "自動核准", default: false }] },
    { type: "core/condition", title: "條件", category: "流程", hint: "判斷值是否符合條件",
      inputs: [{ name: "value", type: "*", label: "值" }], outputs: [{ name: "result", type: "BOOLEAN", label: "結果" }], widgets: condWidgets },
    { type: "core/branch", title: "分支", category: "流程", hint: "依條件走 true 或 false",
      inputs: [{ name: "value", type: "*", label: "值" }, { name: "condition", type: "BOOLEAN", label: "條件", optional: true }],
      outputs: [{ name: "true", type: "*", label: "成立" }, { name: "false", type: "*", label: "不成立" }], widgets: condWidgets },
    { type: "core/merge", title: "合流", category: "流程", hint: "取第一個有效的輸入",
      inputs: [{ name: "a", type: "*", label: "A", optional: true }, { name: "b", type: "*", label: "B", optional: true }, { name: "c", type: "*", label: "C", optional: true }],
      outputs: [{ name: "value", type: "*", label: "值" }], widgets: [] },
    { type: "core/loop-start", title: "迴圈開始", category: "流程", hint: "重複執行區段",
      inputs: [{ name: "init", type: "*", label: "初始值" }],
      outputs: [{ name: "value", type: "*", label: "值" }, { name: "index", type: "NUMBER", label: "輪次" }, { name: "loop", type: "LOOP", label: "迴圈" }],
      widgets: [{ name: "max", kind: "number", label: "最多輪數", default: 3, min: 1, max: 20, step: 1 }] },
    { type: "core/loop-end", title: "迴圈結束", category: "流程", hint: "條件成立就停止",
      inputs: [{ name: "loop", type: "LOOP", label: "迴圈" }, { name: "value", type: "*", label: "值" }, { name: "done", type: "BOOLEAN", label: "完成", optional: true }],
      outputs: [{ name: "result", type: "*", label: "結果" }, { name: "count", type: "NUMBER", label: "輪數" }],
      widgets: [Object.assign({}, condWidgets[0], { default: "truthy" }), condWidgets[1], condWidgets[2]] }
  ];
  demoTypes.forEach(function (d) {
    if (!SG.registry.get(d.type)) SG.registry.register(Object.assign({ async execute() { return {}; } }, d));
  });

  if (SG.Graph) return;

  // ---------------- graph ----------------
  function widgetSlotType(w) {
    return w.type || (w.kind === "number" ? "NUMBER" : w.kind === "toggle" ? "BOOLEAN" : "STRING");
  }

  function Graph(json) {
    this._ls = {};
    this._depth = 0;
    this._past = [];
    this._future = [];
    this._reasons = [];
    this._ids = [];
    const self = this;
    this.history = {
      commit: function () { /* mock: every batch is already one history entry */ },
      undo: function () { self._undo(); },
      redo: function () { self._redo(); },
      get canUndo() { return self._past.length > 0; },
      get canRedo() { return self._future.length > 0; }
    };
    this.load(json);
  }
  const P = Graph.prototype;

  P.on = function (evt, fn) {
    const ls = this._ls;
    (ls[evt] = ls[evt] || []).push(fn);
    return function () { ls[evt] = (ls[evt] || []).filter(function (f) { return f !== fn; }); };
  };
  P._emit = function (evt, data) { (this._ls[evt] || []).slice().forEach(function (fn) { fn(data); }); };
  P._snap = function () { return JSON.stringify({ nodes: this.nodes, links: this.links, groups: this.groups, next: this.next }); };
  P._restore = function (s) { const o = JSON.parse(s); this.nodes = o.nodes; this.links = o.links; this.groups = o.groups; this.next = o.next; };
  P.batch = function (fn) {
    if (this._depth === 0) { this._before = this._snap(); this._reasons = []; this._ids = []; }
    this._depth++;
    let out;
    try { out = fn(); } finally {
      this._depth--;
      if (this._depth === 0) {
        const after = this._snap();
        if (after !== this._before) {
          this._past.push(this._before);
          if (this._past.length > 100) this._past.shift();
          this._future = [];
          this._emit("change", { reason: this._reasons.length === 1 ? this._reasons[0] : "batch", ids: this._ids.slice() });
        }
      }
    }
    return out;
  };
  P._mut = function (reason, ids, fn) {
    const self = this;
    return this.batch(function () { self._reasons.push(reason); (ids || []).forEach(function (i) { self._ids.push(i); }); return fn(); });
  };
  P._undo = function () {
    if (!this._past.length) return;
    this._future.push(this._snap());
    this._restore(this._past.pop());
    this._emit("change", { reason: "undo", ids: [] });
  };
  P._redo = function () {
    if (!this._future.length) return;
    this._past.push(this._snap());
    this._restore(this._future.pop());
    this._emit("change", { reason: "redo", ids: [] });
  };

  P.toJSON = function () {
    return { schema: "sea-agent-studio/workflow", version: 1, agent: this.agent || null,
      nodes: clone(this.nodes), links: clone(this.links), groups: clone(this.groups), view: clone(this.view), next: this.next };
  };
  P.load = function (json) {
    json = json || {};
    const self = this;
    this.agent = json.agent || null;
    this.next = Number.isInteger(json.next) ? json.next : 1;
    this.nodes = (json.nodes || []).map(function (n) { return self._normNode(clone(n)); });
    this.groups = clone(json.groups || []);
    this.view = Object.assign({ x: 0, y: 0, k: 1 }, json.view || {});
    this.links = [];
    (json.links || []).forEach(function (l) {
      if (self.getNode(l.from) && self.getNode(l.to)) self.links.push(clone(l));
    });
    this._past = []; this._future = [];
    this._emit("change", { reason: "load", ids: [] });
  };
  P._normNode = function (n) {
    const def = SG.registry.get(n.type);
    n.x = Number(n.x) || 0; n.y = Number(n.y) || 0;
    n.w = n.w || 220; n.h = n.h || 0;
    n.title = n.title || null; n.mode = n.mode || "normal"; n.collapsed = !!n.collapsed;
    n.widgets = n.widgets || {}; n.converted = n.converted || []; n.props = n.props || {};
    n.retry = n.retry || { max: 0, delay: 0 };
    if (!def) n.missing = true; else delete n.missing;
    return n;
  };
  P.getNode = function (id) { return this.nodes.find(function (n) { return n.id === id; }) || null; };
  P.linksOf = function (id) { return this.links.filter(function (l) { return l.from === id || l.to === id; }); };

  P.addNode = function (type, o) {
    o = o || {};
    const self = this;
    return this._mut("add", [], function () {
      const def = SG.registry.get(type);
      const widgets = {};
      ((def && def.widgets) || []).forEach(function (w) { widgets[w.name] = clone(w.default); });
      Object.assign(widgets, o.widgets || {});
      const n = self._normNode({ id: "n" + self.next++, type: type, x: o.x || 0, y: o.y || 0, w: type === "core/reroute" ? 0 : 220,
        widgets: widgets, props: clone(o.props || {}) });
      self.nodes.push(n);
      self._ids.push(n.id);
      return n;
    });
  };
  P.removeNodes = function (ids) {
    const set = new Set(ids);
    const self = this;
    this._mut("remove", ids, function () {
      self.nodes = self.nodes.filter(function (n) { return !set.has(n.id); });
      self.links = self.links.filter(function (l) { return !set.has(l.from) && !set.has(l.to); });
    });
  };
  P.moveNodes = function (ids, dx, dy) {
    const self = this;
    this._mut("move", ids, function () {
      ids.forEach(function (id) { const n = self.getNode(id); if (n) { n.x += dx; n.y += dy; } });
    });
  };
  P.setWidget = function (id, name, value) {
    const n = this.getNode(id); if (!n) return;
    this._mut("widget", [id], function () { n.widgets[name] = value; });
  };
  P.setMode = function (id, mode) {
    const n = this.getNode(id); if (!n) return;
    this._mut("mode", [id], function () { n.mode = mode; });
  };
  P.setRetry = function (id, r) {
    const n = this.getNode(id); if (!n) return;
    this._mut("retry", [id], function () { n.retry = { max: Math.max(0, Math.min(5, Number(r && r.max) || 0)), delay: Number(r && r.delay) || 0 }; });
  };
  P.convertWidget = function (id, name, toInput) {
    const n = this.getNode(id); if (!n) return;
    const self = this;
    this._mut("convert", [id], function () {
      const i = n.converted.indexOf(name);
      if (toInput && i < 0) n.converted.push(name);
      if (!toInput && i >= 0) {
        n.converted.splice(i, 1);
        self.links = self.links.filter(function (l) { return !(l.to === id && l.in === name); });
      }
    });
  };
  P.slots = function (id) {
    const n = this.getNode(id);
    if (!n) return { inputs: [], outputs: [] };
    const def = SG.registry.get(n.type);
    if (!def) {
      const ins = [], outs = [];
      this.links.forEach(function (l) {
        if (l.to === id && !ins.some(function (s) { return s.name === l.in; })) ins.push({ name: l.in, type: "*", label: l.in });
        if (l.from === id && !outs.some(function (s) { return s.name === l.out; })) outs.push({ name: l.out, type: "*", label: l.out });
      });
      return { inputs: ins, outputs: outs };
    }
    const inputs = (def.inputs || []).map(function (s) { return Object.assign({}, s); });
    (def.widgets || []).forEach(function (w) {
      if (n.converted.indexOf(w.name) >= 0) inputs.push({ name: w.name, type: widgetSlotType(w), label: w.label || w.name, optional: true, widget: true });
    });
    return { inputs: inputs, outputs: (def.outputs || []).map(function (s) { return Object.assign({}, s); }) };
  };
  P._reaches = function (a, b) {
    const seen = new Set([a]), stack = [a];
    while (stack.length) {
      const id = stack.pop();
      if (id === b) return true;
      this.links.forEach(function (l) { if (l.from === id && !seen.has(l.to)) { seen.add(l.to); stack.push(l.to); } });
    }
    return false;
  };
  P.canConnect = function (from, out, to, inp) {
    const a = this.getNode(from), b = this.getNode(to);
    if (!a || !b) return { ok: false, reason: "找不到節點" };
    if (from === to) return { ok: false, reason: "不能連到自己" };
    const os = this.slots(from).outputs.find(function (s) { return s.name === out; });
    const is = this.slots(to).inputs.find(function (s) { return s.name === inp; });
    if (!os || !is) return { ok: false, reason: "找不到插槽" };
    if (!SG.types.compatible(os.type, is.type)) {
      return { ok: false, reason: "型別不相容：「" + SG.types.get(os.type).label + "」不能接到「" + SG.types.get(is.type).label + "」" };
    }
    if (this._reaches(to, from)) return { ok: false, reason: "會形成循環" };
    return { ok: true };
  };
  P.connect = function (from, out, to, inp) {
    if (!this.canConnect(from, out, to, inp).ok) return null;
    const self = this;
    return this._mut("connect", [from, to], function () {
      self.links = self.links.filter(function (l) { return !(l.to === to && l.in === inp); });
      const l = { id: "l" + self.next++, from: from, out: out, to: to, in: inp };
      self.links.push(l);
      return l;
    });
  };
  P.disconnect = function (linkId) {
    const self = this;
    this._mut("disconnect", [], function () { self.links = self.links.filter(function (l) { return l.id !== linkId; }); });
  };
  P.addGroup = function (r) {
    const self = this;
    return this._mut("group", [], function () {
      const g = { id: "g" + self.next++, title: r.title || "群組", x: r.x || 0, y: r.y || 0, w: r.w || 300, h: r.h || 200, color: r.color || "#3b82f6" };
      self.groups.push(g);
      return g;
    });
  };
  P.updateGroup = function (id, patch) {
    const g = this.groups.find(function (x) { return x.id === id; }); if (!g) return;
    this._mut("group", [], function () { Object.assign(g, patch); });
  };
  P.removeGroup = function (id) {
    const self = this;
    this._mut("group", [], function () { self.groups = self.groups.filter(function (g) { return g.id !== id; }); });
  };
  P.setView = function (v) {
    this.view = { x: Number(v.x) || 0, y: Number(v.y) || 0, k: Number(v.k) || 1 };
    this._emit("change", { reason: "view", ids: [] });
  };
  P.validate = function () {
    const self = this, out = [];
    this.nodes.forEach(function (n) {
      if (n.missing) { out.push({ level: "error", nodeId: n.id, message: "缺少節點類型：" + n.type }); return; }
      self.slots(n.id).inputs.forEach(function (s) {
        if (!s.optional && !self.links.some(function (l) { return l.to === n.id && l.in === s.name; })) {
          out.push({ level: "error", nodeId: n.id, slot: s.name, message: "缺少輸入：" + (s.label || s.name) });
        }
      });
    });
    return out;
  };
  P.order = function () {
    const indeg = new Map(this.nodes.map(function (n) { return [n.id, 0]; }));
    this.links.forEach(function (l) { indeg.set(l.to, (indeg.get(l.to) || 0) + 1); });
    const q = this.nodes.filter(function (n) { return !indeg.get(n.id); }).map(function (n) { return n.id; });
    const out = [];
    while (q.length) {
      const id = q.shift();
      out.push(id);
      this.links.forEach(function (l) {
        if (l.from === id) { indeg.set(l.to, indeg.get(l.to) - 1); if (indeg.get(l.to) === 0) q.push(l.to); }
      });
    }
    if (out.length !== this.nodes.length) throw SG.CycleError("發現循環");
    return out;
  };
  P.copy = function (ids) {
    const set = new Set(ids);
    return {
      nodes: clone(this.nodes.filter(function (n) { return set.has(n.id); })),
      links: clone(this.links.filter(function (l) { return set.has(l.from) && set.has(l.to); }))
    };
  };
  P.paste = function (clip, at) {
    if (!clip || !clip.nodes || !clip.nodes.length) return [];
    const self = this;
    at = at || { x: 0, y: 0 };
    const minX = Math.min.apply(null, clip.nodes.map(function (n) { return n.x; }));
    const minY = Math.min.apply(null, clip.nodes.map(function (n) { return n.y; }));
    return this._mut("paste", [], function () {
      const map = {};
      const ids = clip.nodes.map(function (n0) {
        const n = clone(n0);
        n.id = "n" + self.next++;
        map[n0.id] = n.id;
        n.x = n0.x - minX + at.x; n.y = n0.y - minY + at.y;
        self.nodes.push(self._normNode(n));
        return n.id;
      });
      clip.links.forEach(function (l) {
        self.links.push({ id: "l" + self.next++, from: map[l.from], out: l.out, to: map[l.to], in: l.in });
      });
      return ids;
    });
  };

  SG.Graph = Graph;
  SG.__mockEngine = true;
})(globalThis);
