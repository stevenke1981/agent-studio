/* SeaGraph engine: types, registry, Graph model, validation, history,
 * clipboard and serialisation. DOM-free classic script (also loads in Node).
 *
 * Contract notes (interpretations of docs/comfy-plan.md, workstream A):
 *  1. History: every mutating Graph method records one undo entry (JSON
 *     snapshot, cap 100). Consecutive moveNodes() calls on the same id set
 *     coalesce into ONE entry until history.commit() (or any other entry)
 *     seals it, so a canvas may either call moveNodes per pointermove and
 *     commit on drag end, or mutate node.x/y directly and call
 *     history.commit(label) on drag end. commit() only adds an entry when the
 *     state differs from the last entry. Inside batch() commit() is a no-op.
 *  2. setView(view) creates no history entry; it emits "change"
 *     {reason:"view", ids:[]} and also a "view" event {view}. Renderers that
 *     only care about the model can ignore reason "view". batch() nests: an
 *     inner batch joins the outermost one. setTitle(id,t|null) and
 *     setCollapsed(id,bool) are history-recorded (reason "update").
 *  3. Undo/redo emit "change" {reason:"undo"|"redo", ids:[]}. load() emits
 *     "change" {reason:"load"} and resets history. Node objects are replaced
 *     on undo/redo/load, so consumers must re-read them by id after "change".
 *  4. linksOf(id) returns an array of every link touching the node (in or out).
 *  5. addNode() with an unregistered type returns null (load()/paste() keep
 *     unknown types as missing placeholders instead: node.missing === true).
 *     node.missing is runtime-only and is not written by toJSON().
 *  6. Widgets are convertible to inputs unless the widget says
 *     convertible:false. A widget whose name equals a definition input name
 *     cannot be converted. A converted, unlinked input is a validate() error.
 *     Converted input slot type = widget.type || STRING (text/textarea/select)
 *     | NUMBER (number) | BOOLEAN (toggle).
 *  7. Virtual nodes (def.virtual) are omitted from g.order(); a virtual node
 *     with at least one input passes its first input through to its outputs
 *     (reroute). g.inputSource(id, inName) resolves through reroute chains.
 *  8. order() with no targets = all output nodes (def.output); if the graph has
 *     no output nodes, every node. Upstream dependencies are always included.
 *  9. g.warnings is an array of zh-Hant strings filled by load(); paste()
 *     problems are appended to it too.
 * 10. Extra helpers beyond the contract: g.updateNode(id, patch) for
 *     title/collapsed/w/h/x/y/props (props shallow-merged), g.nodesInGroup(id),
 *     g.inputLink(id,inName), g.inputSource(id,inName), g.nodeDef(id),
 *     g.setMode(ids[],mode), registry.on("change",fn), SG.hash,
 *     SG.stableStringify, SG.previewText, SG.Emitter. A registry definition may
 *     carry validate(node, graph) -> [{level,message,slot?}] which validate()
 *     merges (used for permission-aware wiring).
 * 11. A registry definition may set typeFrom:"<inputName>": its "*" outputs
 *     then report the upstream type of that input (core/approval uses this,
 *     like reroute). canConnect checks downstream consumers through it.
 * 12. Executor (Amendment 1): ex.pending() is the approval list; the queue
 *     count is ex.queued and the "queue" event {pending:number} counts
 *     waiting + running jobs. The note given to ex.approve(id, ok, note) is
 *     exposed to the node as ctx.approvalNote after requestApproval settles.
 *     Downstream cache keys of a nocache node include a hash of its latest
 *     output, so unchanged values keep downstream nodes cached.
 *     Bypass emits node-done {bypassed:true} (result status "done").
 *     cancel() aborts the running job AND drops queued jobs (each resolves
 *     with status "cancelled"). A "blocked" skip makes run-end status "error".
 *     delay(ms) is called after each executed node with opts.stepMs
 *     (default 200) and after cached nodes with 0.
 * 13. Control flow (Amendment 2): SG.INACTIVE / SG.isInactive mark the
 *     non-taken branch output. A node skips with reason "branch" when a
 *     required input is inactive, or when it has linked inputs and none of
 *     them is active (so core/merge with every input inactive skips "branch",
 *     which downstream treats exactly like an INACTIVE value). An "upstream"
 *     failure wins over "branch". Condition select options are
 *     [{value,label}] (SG.control.CONDITION_MODES); SG.control.evalCondition
 *     is the shared, eval-free evaluator. Loops: defs flagged loopStart /
 *     loopEnd; g.loops() -> {loops, issues}; validate() includes the issues.
 *     loop-start/loop-end in mute/bypass mode, or a loop-end outside the run
 *     targets, make the loop run once as ordinary nodes. Within an iterating
 *     loop, S/body nodes emit node-start/node-done every iteration (with
 *     `iteration`); loop-end emits node-start once and node-done once (with
 *     `iterations`). The loop-end result carries maxed:true and text
 *     "<preview>（已達上限 N 輪）" when it stopped at max. A cached loop
 *     replays every region node as cached. Retry: node.retry {max,delay} is
 *     always present in node JSON; node-retry.attempt is 1-based (the retry
 *     about to start, equal to ctx.attempt of that try). Errors with
 *     retryable:false (approval rejection, invalid regex) and AbortError are
 *     never retried. results[i].attempts = tries made (0 when cached/skipped).
 *     No new file: everything lives in graph.js / executor.js / core-nodes.js.
 */
(function (root) {
  "use strict";
  const SG = root.SeaGraph = root.SeaGraph || {};

  // ------------------------------------------------------------------ utils
  function isObj(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function toIds(ids) {
    if (ids == null) return [];
    return (Array.isArray(ids) ? ids : [ids]).filter(function (x) { return typeof x === "string"; });
  }

  function stableStringify(value) {
    const seen = [];
    function walk(x) {
      if (x === null) return "null";
      const t = typeof x;
      if (t === "number") return Number.isFinite(x) ? String(x) : "null";
      if (t === "boolean") return x ? "true" : "false";
      if (t === "string") return JSON.stringify(x);
      if (t === "bigint") return JSON.stringify(String(x));
      if (t !== "object") return undefined; // undefined, function, symbol
      if (seen.indexOf(x) >= 0) return "\"[circular]\"";
      seen.push(x);
      let out;
      if (Array.isArray(x)) {
        out = "[" + x.map(function (i) { const s = walk(i); return s === undefined ? "null" : s; }).join(",") + "]";
      } else {
        const parts = [];
        Object.keys(x).sort().forEach(function (k) {
          const s = walk(x[k]);
          if (s !== undefined) parts.push(JSON.stringify(k) + ":" + s);
        });
        out = "{" + parts.join(",") + "}";
      }
      seen.pop();
      return out;
    }
    const r = walk(value);
    return r === undefined ? "null" : r;
  }

  function fnv1a(str, h) {
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  function hex8(n) { return ("00000000" + n.toString(16)).slice(-8); }
  /** Stable 64-bit-ish hash (two FNV-1a lanes) of a string or any JSON value. */
  function hash(value) {
    const s = typeof value === "string" ? value : stableStringify(value);
    const a = fnv1a(s, 0x811c9dc5);
    const b = fnv1a(s, 0x9dc5811c ^ a);
    return hex8(a) + hex8(b);
  }

  /** Preview text convention: value.text, else String(value), JSON for plain objects. */
  function previewText(v) {
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      if (typeof v.text === "string") return v.text;
      try { return JSON.stringify(v); } catch (e) { return String(v); }
    }
    return String(v);
  }

  class Emitter {
    constructor() { this._ev = Object.create(null); }
    on(evt, fn) {
      if (typeof fn !== "function") return function () {};
      (this._ev[evt] = this._ev[evt] || []).push(fn);
      const self = this;
      return function off() { self.off(evt, fn); };
    }
    off(evt, fn) {
      const list = this._ev[evt];
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    }
    emit(evt, payload) {
      const list = this._ev[evt];
      if (!list || !list.length) return;
      list.slice().forEach(function (fn) {
        try { fn(payload); } catch (e) {
          if (root.console && root.console.error) root.console.error("SeaGraph listener error (" + evt + "):", e);
        }
      });
    }
  }

  class CycleError extends Error {
    constructor(ids, message) {
      super(message || "圖中有循環連線，請移除其中一條連線。");
      this.name = "CycleError";
      this.ids = ids || [];
    }
  }

  // ------------------------------------------------------------------ types
  const typeDefs = Object.create(null);
  const DEFAULT_COLOR = "#94a3b8";
  function splitTypes(t) { return String(t).split(",").map(function (s) { return s.trim(); }).filter(Boolean); }

  const types = {
    define: function (id, spec) {
      spec = spec || {};
      typeDefs[id] = {
        id: id,
        label: spec.label || String(id),
        color: spec.color || DEFAULT_COLOR,
        accepts: Array.isArray(spec.accepts) ? spec.accepts.slice() : []
      };
      return typeDefs[id];
    },
    get: function (id) {
      return typeDefs[id] || { id: id, label: id == null ? "?" : String(id), color: DEFAULT_COLOR, accepts: [] };
    },
    has: function (id) { return !!typeDefs[id]; },
    list: function () { return Object.keys(typeDefs).map(function (k) { return typeDefs[k]; }); },
    compatible: function (outType, inType) {
      if (outType == null || inType == null) return false;
      if (outType === "*" || inType === "*" || outType === inType) return true;
      const outs = splitTypes(outType), ins = splitTypes(inType);
      for (let i = 0; i < outs.length; i++) {
        for (let j = 0; j < ins.length; j++) {
          const o = outs[i], n = ins[j];
          if (o === "*" || n === "*" || o === n) return true;
          const d = typeDefs[n];
          if (d && (d.accepts.indexOf(o) >= 0 || d.accepts.indexOf("*") >= 0)) return true;
        }
      }
      return false;
    }
  };
  types.define("*", { label: "任意", color: "#94a3b8" });
  types.define("STRING", { label: "文字", color: "#22c55e" });
  types.define("NUMBER", { label: "數字", color: "#f59e0b" });
  types.define("BOOLEAN", { label: "布林", color: "#a855f7" });
  types.define("LOOP", { label: "迴圈", color: "#14b8a6" });

  // ------------------------------------------------------- control helpers
  /** Marker carried by the non-taken output of core/branch. */
  const INACTIVE = Object.freeze({ __seaInactive: true, text: "" });
  function isInactive(v) { return v === INACTIVE || !!(v && typeof v === "object" && v.__seaInactive === true); }

  const CONDITION_MODES = [
    { value: "nonempty", label: "非空" },
    { value: "contains", label: "包含文字" },
    { value: "equals", label: "等於" },
    { value: "regex", label: "符合規則" },
    { value: "truthy", label: "為真" }
  ];
  function condText(v) {
    if (v === undefined || v === null) return "";
    if (typeof v === "object" && typeof v.text === "string") return v.text;
    if (typeof v === "object") { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    return String(v);
  }
  function truthy(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    if (v === undefined || v === null || isInactive(v)) return false;
    const t = condText(v).trim().toLowerCase();
    return t !== "" && ["false", "0", "no", "off", "否", "假"].indexOf(t) < 0;
  }
  /** Evaluate a condition (no eval). Throws Error(retryable:false) on an invalid regex. */
  function evalCondition(value, opts) {
    opts = opts || {};
    const mode = opts.mode || "nonempty";
    const pattern = opts.pattern == null ? "" : String(opts.pattern);
    const text = condText(value);
    let r;
    if (mode === "contains") r = text.indexOf(pattern) >= 0;
    else if (mode === "equals") r = text === pattern;
    else if (mode === "regex") {
      let re;
      try { re = new RegExp(pattern); } catch (e) {
        const err = new Error("規則格式錯誤：「" + pattern + "」");
        err.retryable = false;
        throw err;
      }
      r = re.test(text);
    } else if (mode === "truthy") r = truthy(value);
    else r = text.trim().length > 0;
    return opts.negate ? !r : r;
  }
  function conditionWidgets(defaultMode) {
    return [
      { name: "mode", kind: "select", label: "條件", options: CONDITION_MODES.map(function (o) { return Object.assign({}, o); }), default: defaultMode || "nonempty", convertible: false },
      { name: "pattern", kind: "text", label: "比對文字", default: "" },
      { name: "negate", kind: "toggle", label: "反轉結果", default: false, convertible: false }
    ];
  }
  function normRetry(r) {
    r = isObj(r) ? r : {};
    return { max: Math.max(0, Math.min(5, Math.floor(num(r.max, 0)))), delay: Math.max(0, num(r.delay, 0)) };
  }

  const KIND_TYPE = { text: "STRING", textarea: "STRING", select: "STRING", number: "NUMBER", toggle: "BOOLEAN" };
  const KINDS = ["text", "number", "select", "toggle", "textarea"];

  // --------------------------------------------------------------- registry
  const regDefs = new Map();
  const regEm = new Emitter();

  function widgetDefault(w) {
    if (w.default !== undefined) return clone(w.default);
    if (w.kind === "number") return Number.isFinite(w.min) ? w.min : 0;
    if (w.kind === "toggle") return false;
    if (w.kind === "select" && Array.isArray(w.options) && w.options.length) {
      const o = w.options[0];
      return isObj(o) ? o.value : o;
    }
    return "";
  }

  function normDef(def) {
    if (!def || typeof def.type !== "string" || !def.type) throw new TypeError("SeaGraph.registry.register: type is required");
    const d = Object.assign({}, def);
    d.title = def.title || def.type;
    d.category = def.category || "";
    d.hint = def.hint || "";
    d.inputs = (def.inputs || []).map(function (s) {
      return Object.assign({}, s, { name: String(s.name), type: s.type || "*", label: s.label || String(s.name), optional: !!s.optional });
    });
    d.outputs = (def.outputs || []).map(function (s) {
      return Object.assign({}, s, { name: String(s.name), type: s.type || "*", label: s.label || String(s.name) });
    });
    d.widgets = (def.widgets || []).map(function (w) {
      const kind = KINDS.indexOf(w.kind) >= 0 ? w.kind : "text";
      const nw = Object.assign({}, w, { name: String(w.name), kind: kind, label: w.label || String(w.name), convertible: w.convertible !== false });
      nw.default = widgetDefault(nw);
      return nw;
    });
    d.output = !!def.output;
    d.virtual = !!def.virtual;
    return d;
  }

  const registry = {
    register: function (def) {
      const d = normDef(def);
      regDefs.set(d.type, d);
      regEm.emit("change", { reason: "register", type: d.type });
      return d;
    },
    get: function (type) { return regDefs.get(type); },
    has: function (type) { return regDefs.has(type); },
    list: function () { return Array.from(regDefs.values()); },
    search: function (text) {
      const q = String(text == null ? "" : text).trim().toLowerCase();
      const all = registry.list();
      if (!q) return all;
      const scored = [];
      all.forEach(function (d, i) {
        const title = String(d.title).toLowerCase();
        const fields = [d.type, d.category, d.hint].map(function (s) { return String(s || "").toLowerCase(); });
        let score = -1;
        if (title.indexOf(q) === 0) score = 0;
        else if (title.indexOf(q) >= 0) score = 1;
        else if (fields[0].indexOf(q) >= 0) score = 2;
        else if (fields[1].indexOf(q) >= 0) score = 3;
        else if (fields[2].indexOf(q) >= 0) score = 4;
        if (score >= 0) scored.push({ d: d, s: score, i: i });
      });
      scored.sort(function (a, b) { return a.s - b.s || a.i - b.i; });
      return scored.map(function (x) { return x.d; });
    },
    unregister: function (type) {
      const had = regDefs.delete(type);
      if (had) regEm.emit("change", { reason: "unregister", type: type });
      return had;
    },
    on: function (evt, fn) { return regEm.on(evt, fn); },
    off: function (evt, fn) { regEm.off(evt, fn); }
  };

  // ------------------------------------------------------------------ graph
  const MODES = ["normal", "bypass", "mute"];
  const SCHEMA = "sea-agent-studio/workflow";
  const HISTORY_CAP = 100;

  function idNum(id) {
    const m = /^[nlg](\d+)$/.exec(String(id));
    return m ? Number(m[1]) : 0;
  }

  class Graph extends Emitter {
    constructor(json, opts) {
      super();
      opts = opts || {};
      this.registry = opts.registry || null;
      this.types = opts.types || null;
      this.nodes = [];
      this.links = [];
      this.groups = [];
      this.view = { x: 0, y: 0, k: 1 };
      this.next = 1;
      this.agent = null;
      this.warnings = [];
      this._byId = new Map();
      this._batch = null;
      this._hist = [];
      this._hIdx = -1;
      const g = this;
      this.history = {
        cap: HISTORY_CAP,
        commit: function (label) { return g._commit(label); },
        undo: function () { return g._undo(); },
        redo: function () { return g._redo(); },
        clear: function () { g._resetHistory(); },
        get canUndo() { return g._hIdx > 0 || g._uncommitted(); },
        get canRedo() { return g._hIdx < g._hist.length - 1 && !g._uncommitted(); },
        get size() { return g._hist.length - 1; },
        get labels() { return g._hist.slice(1).map(function (e) { return e.label; }); }
      };
      if (json) this._loadInto(json, { resetWarnings: true });
      this._resetHistory();
    }

    _reg() { return this.registry || SG.registry; }
    _types() { return this.types || SG.types; }
    _reindex() { const m = new Map(); this.nodes.forEach(function (n) { m.set(n.id, n); }); this._byId = m; }
    _newId(prefix) { return prefix + (this.next++); }

    // ------------------------------------------------------------- serialise
    _nodeJSON(n, internal) {
      const o = {
        id: n.id, type: n.type, x: n.x, y: n.y, w: n.w, h: n.h,
        title: n.title, mode: n.mode, collapsed: n.collapsed,
        widgets: clone(n.widgets), converted: n.converted.slice(), props: clone(n.props),
        retry: { max: n.retry.max, delay: n.retry.delay }
      };
      if (internal && n.missing) o.missingSlots = clone(n.missingSlots);
      return o;
    }
    _linkJSON(l) { return { id: l.id, from: l.from, out: l.out, to: l.to, in: l.in }; }

    toJSON() {
      const self = this;
      return {
        schema: SCHEMA, version: 1, agent: this.agent,
        nodes: this.nodes.map(function (n) { return self._nodeJSON(n, false); }),
        links: this.links.map(function (l) { return self._linkJSON(l); }),
        groups: clone(this.groups),
        view: clone(this.view),
        next: this.next
      };
    }

    load(json) {
      this._loadInto(json, { resetWarnings: true });
      this._resetHistory();
      this.emit("change", { reason: "load", ids: [] });
      return this;
    }

    _normNode(raw, warn) {
      if (!isObj(raw) || typeof raw.type !== "string" || !raw.type) {
        warn("已略過格式不正確的節點" + (raw && raw.id ? "「" + raw.id + "」" : "") + "。");
        return null;
      }
      const def = this._reg().get(raw.type);
      const n = {
        id: typeof raw.id === "string" && raw.id ? raw.id : null,
        type: raw.type,
        x: num(raw.x, 0), y: num(raw.y, 0),
        w: num(raw.w, def && def.width ? def.width : 220), h: num(raw.h, 0),
        title: typeof raw.title === "string" ? raw.title : null,
        mode: MODES.indexOf(raw.mode) >= 0 ? raw.mode : "normal",
        collapsed: !!raw.collapsed,
        widgets: {},
        converted: [],
        props: isObj(raw.props) ? clone(raw.props) : {},
        retry: normRetry(raw.retry)
      };
      if (def) def.widgets.forEach(function (w) { n.widgets[w.name] = clone(w.default); });
      if (isObj(raw.widgets)) {
        Object.keys(raw.widgets).forEach(function (k) {
          if (raw.widgets[k] !== undefined) n.widgets[k] = clone(raw.widgets[k]);
        });
      }
      const conv = Array.isArray(raw.converted) ? raw.converted : [];
      if (def) {
        conv.forEach(function (name) {
          const w = def.widgets.find(function (x) { return x.name === name; });
          const clash = def.inputs.some(function (s) { return s.name === name; });
          if (w && w.convertible && !clash) { if (n.converted.indexOf(name) < 0) n.converted.push(name); }
          else warn("節點「" + (n.id || raw.type) + "」的欄位「" + name + "」無法轉為輸入，已還原為欄位。");
        });
      } else {
        n.converted = conv.filter(function (x) { return typeof x === "string"; });
        n.missing = true;
        const ms = isObj(raw.missingSlots) ? raw.missingSlots : {};
        n.missingSlots = {
          inputs: (Array.isArray(ms.inputs) ? ms.inputs : []).map(function (s) { return { name: String(s.name), type: s.type || "*", label: s.label || String(s.name), optional: !!s.optional }; }),
          outputs: (Array.isArray(ms.outputs) ? ms.outputs : []).map(function (s) { return { name: String(s.name), type: s.type || "*", label: s.label || String(s.name) }; })
        };
        warn("節點「" + (n.id || "?") + "」的類型「" + raw.type + "」未註冊，已保留為遺失節點。");
      }
      return n;
    }

    /** Structural link check used by load/paste; infers slots on missing nodes. */
    _acceptLink(l, warn, taken) {
      const bad = function (why) { warn("已移除無效連線「" + (l && l.id ? l.id : "?") + "」：" + why); return false; };
      if (!isObj(l)) return bad("格式不正確。");
      const a = this._byId.get(l.from), b = this._byId.get(l.to);
      if (!a || !b) return bad("找不到連接的節點。");
      if (a === b) return bad("節點不能連到自己。");
      const out = String(l.out), inp = String(l.in);
      if (!a.missing && !this.slots(a.id).outputs.some(function (s) { return s.name === out; })) return bad("找不到輸出埠「" + out + "」。");
      if (!b.missing && !this.slots(b.id).inputs.some(function (s) { return s.name === inp; })) return bad("找不到輸入埠「" + inp + "」。");
      const k = b.id + "\u0000" + inp;
      if (taken.has(k)) return bad("輸入埠「" + inp + "」已有連線。");
      taken.add(k);
      if (a.missing && !a.missingSlots.outputs.some(function (s) { return s.name === out; })) a.missingSlots.outputs.push({ name: out, type: "*", label: out });
      if (b.missing && !b.missingSlots.inputs.some(function (s) { return s.name === inp; })) b.missingSlots.inputs.push({ name: inp, type: "*", label: inp, optional: false });
      return true;
    }

    _loadInto(json, opts) {
      opts = opts || {};
      const warnings = [];
      const warn = function (m) { warnings.push(m); };
      if (typeof json === "string") {
        try { json = JSON.parse(json); } catch (e) { json = null; }
      }
      if (!isObj(json)) { warn("工作流程格式不正確，已載入空白圖。"); json = {}; }
      if (json.schema && json.schema !== SCHEMA && json.schema !== "sea-agent-studio/clip") warn("未知的工作流程格式「" + json.schema + "」，已盡量載入。");
      const self = this;
      let maxId = 0;
      this.nodes = [];
      this._byId = new Map();
      (Array.isArray(json.nodes) ? json.nodes : []).forEach(function (raw) {
        const n = self._normNode(raw, warn);
        if (!n) return;
        if (!n.id) { warn("節點缺少 id，已略過。"); return; }
        if (self._byId.has(n.id)) { warn("節點 id 重複「" + n.id + "」，已略過。"); return; }
        self.nodes.push(n);
        self._byId.set(n.id, n);
        maxId = Math.max(maxId, idNum(n.id));
      });
      this.links = [];
      const taken = new Set(), linkIds = new Set();
      (Array.isArray(json.links) ? json.links : []).forEach(function (l) {
        if (!self._acceptLink(l, warn, taken)) return;
        let id = typeof l.id === "string" && l.id && !linkIds.has(l.id) ? l.id : null;
        if (!id) id = "__tmp" + linkIds.size;
        linkIds.add(id);
        self.links.push({ id: id, from: l.from, out: String(l.out), to: l.to, in: String(l.in) });
        maxId = Math.max(maxId, idNum(id));
      });
      this.groups = [];
      (Array.isArray(json.groups) ? json.groups : []).forEach(function (raw) {
        if (!isObj(raw) || typeof raw.id !== "string") { warn("已略過格式不正確的群組。"); return; }
        if (self.groups.some(function (x) { return x.id === raw.id; })) { warn("群組 id 重複「" + raw.id + "」，已略過。"); return; }
        self.groups.push(self._normGroup(raw, raw.id));
        maxId = Math.max(maxId, idNum(raw.id));
      });
      this.next = Math.max(num(json.next, 1), maxId + 1, 1);
      // give fresh ids to links that had none / duplicates
      this.links.forEach(function (l) { if (l.id.indexOf("__tmp") === 0) l.id = self._newId("l"); });
      if (!opts.keepView) this.view = this._normView(json.view);
      if (json.agent !== undefined) this.agent = json.agent;
      else if (!opts.keepView) this.agent = null;
      if (opts.resetWarnings) this.warnings = warnings;
      else warnings.forEach(function (w) { self.warnings.push(w); });
    }

    _normGroup(raw, id) {
      return {
        id: id, title: typeof raw.title === "string" ? raw.title : "群組",
        x: num(raw.x, 0), y: num(raw.y, 0), w: Math.max(0, num(raw.w, 320)), h: Math.max(0, num(raw.h, 200)),
        color: typeof raw.color === "string" ? raw.color : "#3b82f6"
      };
    }
    _normView(v) {
      v = isObj(v) ? v : {};
      const k = num(v.k, 1);
      return { x: num(v.x, 0), y: num(v.y, 0), k: k > 0 ? Math.min(8, Math.max(0.05, k)) : 1 };
    }

    // --------------------------------------------------------------- history
    _snapshot() {
      const self = this;
      return JSON.stringify({
        agent: this.agent,
        nodes: this.nodes.map(function (n) { return self._nodeJSON(n, true); }),
        links: this.links.map(function (l) { return self._linkJSON(l); }),
        groups: this.groups, next: this.next
      });
    }
    _resetHistory() { this._hist = [{ label: "初始", reason: "init", snap: this._snapshot(), ids: null, sealed: true }]; this._hIdx = 0; }
    _uncommitted() { return this._hIdx >= 0 && this._hist[this._hIdx].snap !== this._snapshot(); }
    _record(reason, ids, label) {
      const snap = this._snapshot();
      const top = this._hist[this._hIdx];
      if (top && top.snap === snap) return false;
      const key = ids ? ids.slice().sort().join(",") : "";
      if (reason === "move" && top && top.reason === "move" && !top.sealed && top.ids === key && this._hIdx === this._hist.length - 1) {
        top.snap = snap;
        return true;
      }
      this._hist.length = this._hIdx + 1;
      this._hist.push({ label: label || reason, reason: reason, snap: snap, ids: key, sealed: reason !== "move" });
      while (this._hist.length > HISTORY_CAP + 1) this._hist.shift();
      this._hIdx = this._hist.length - 1;
      return true;
    }
    _commit(label) {
      if (this._batch) { if (label) this._batch.label = label; this._batch.commit = true; return false; }
      const top = this._hist[this._hIdx];
      const added = this._record("commit", null, label || "編輯");
      if (!added && top) top.sealed = true;
      if (added) this.emit("change", { reason: "commit", ids: [] });
      return added;
    }
    _restore(snap) {
      const keepWarnings = this.warnings;
      this._loadInto(JSON.parse(snap), { keepView: true, resetWarnings: true });
      this.warnings = keepWarnings;
    }
    _undo() {
      if (this._batch) return false;
      if (this._uncommitted()) this._record("commit", null, "未提交的變更");
      if (this._hIdx <= 0) return false;
      this._hIdx--;
      this._restore(this._hist[this._hIdx].snap);
      this.emit("change", { reason: "undo", ids: [] });
      return true;
    }
    _redo() {
      if (this._batch) return false;
      if (this._hIdx >= this._hist.length - 1 || this._uncommitted()) return false;
      this._hIdx++;
      this._restore(this._hist[this._hIdx].snap);
      this.emit("change", { reason: "redo", ids: [] });
      return true;
    }

    _change(reason, ids) {
      ids = ids || [];
      if (this._batch) {
        if (this._batch.reasons.indexOf(reason) < 0) this._batch.reasons.push(reason);
        const set = this._batch.ids;
        ids.forEach(function (i) { set.add(i); });
        return;
      }
      this._record(reason, ids);
      this.emit("change", { reason: reason, ids: ids.slice() });
    }

    /** Nestable: inner batches join the outermost one (one change event, one history entry). */
    batch(fn, label) {
      if (this._batch) {
        if (label && !this._batch.label) this._batch.label = label;
        return fn(this);
      }
      this._batch = { reasons: [], ids: new Set(), label: label || null, commit: false };
      let result;
      try { result = fn(this); }
      finally {
        const b = this._batch;
        this._batch = null;
        if (b.reasons.length || b.commit) {
          const reason = b.reasons.length === 1 ? b.reasons[0] : b.reasons.length ? "batch" : "commit";
          const ids = Array.from(b.ids);
          const recorded = this._record(reason === "move" ? "batch" : reason, ids, b.label || reason);
          if (b.reasons.length || recorded) this.emit("change", { reason: reason, ids: ids, reasons: b.reasons.slice() });
        }
      }
      return result;
    }

    /** No history entry; emits "change" {reason:"view"} and "view" {view}. */
    setView(view) {
      const v = this._normView(Object.assign({}, this.view, view || {}));
      if (v.x === this.view.x && v.y === this.view.y && v.k === this.view.k) return false;
      this.view = v;
      this.emit("change", { reason: "view", ids: [] });
      this.emit("view", { view: clone(v) });
      return true;
    }

    setTitle(id, title) { return this.updateNode(id, { title: typeof title === "string" ? title : null }); }
    setCollapsed(id, collapsed) { return this.updateNode(id, { collapsed: !!collapsed }); }

    // ----------------------------------------------------------------- nodes
    getNode(id) { return this._byId.get(id); }
    nodeDef(id) { const n = this._byId.get(id); return n ? this._reg().get(n.type) : undefined; }

    addNode(type, opts) {
      opts = opts || {};
      const def = this._reg().get(type);
      if (!def) return null;
      const n = this._normNode({
        id: "x", type: type, x: opts.x, y: opts.y, w: opts.w, h: opts.h, title: opts.title,
        mode: opts.mode, widgets: opts.widgets, converted: opts.converted, props: opts.props, retry: opts.retry
      }, function () {});
      n.id = this._newId("n");
      this.nodes.push(n);
      this._byId.set(n.id, n);
      this._change("add", [n.id]);
      return n;
    }

    removeNodes(ids) {
      const set = new Set(toIds(ids).filter((id) => this._byId.has(id)));
      if (!set.size) return false;
      this.nodes = this.nodes.filter(function (n) { return !set.has(n.id); });
      this.links = this.links.filter(function (l) { return !set.has(l.from) && !set.has(l.to); });
      this._reindex();
      this._change("remove", Array.from(set));
      return true;
    }

    moveNodes(ids, dx, dy) {
      dx = num(dx, 0); dy = num(dy, 0);
      const list = toIds(ids).map((id) => this._byId.get(id)).filter(Boolean);
      if (!list.length || (!dx && !dy)) return false;
      list.forEach(function (n) { n.x += dx; n.y += dy; });
      this._change("move", list.map(function (n) { return n.id; }));
      return true;
    }

    updateNode(id, patch) {
      const n = this._byId.get(id);
      if (!n || !isObj(patch)) return false;
      let changed = false;
      ["x", "y", "w", "h"].forEach(function (k) {
        if (patch[k] !== undefined) { const v = num(patch[k], n[k]); if (v !== n[k]) { n[k] = v; changed = true; } }
      });
      if (patch.title !== undefined) { const t = typeof patch.title === "string" ? patch.title : null; if (t !== n.title) { n.title = t; changed = true; } }
      if (patch.collapsed !== undefined && !!patch.collapsed !== n.collapsed) { n.collapsed = !!patch.collapsed; changed = true; }
      if (isObj(patch.props)) {
        const next = Object.assign({}, n.props, clone(patch.props));
        if (stableStringify(next) !== stableStringify(n.props)) { n.props = next; changed = true; }
      }
      if (changed) this._change("update", [id]);
      return changed;
    }

    setWidget(id, name, value) {
      const n = this._byId.get(id);
      if (!n) return false;
      const def = this._reg().get(n.type);
      if (def && !def.widgets.some(function (w) { return w.name === name; })) return false;
      if (stableStringify(n.widgets[name]) === stableStringify(value) && (name in n.widgets)) return false;
      n.widgets[name] = clone(value);
      this._change("widget", [id]);
      return true;
    }

    setMode(ids, mode) {
      if (MODES.indexOf(mode) < 0) return false;
      const list = toIds(ids).map((id) => this._byId.get(id)).filter(function (n) { return n && n.mode !== mode; });
      if (!list.length) return false;
      list.forEach(function (n) { n.mode = mode; });
      this._change("mode", list.map(function (n) { return n.id; }));
      return true;
    }

    /** Retry policy {max:0..5, delay:ms}; one history entry. */
    setRetry(id, retry) {
      const n = this._byId.get(id);
      if (!n) return false;
      const r = normRetry(Object.assign({}, n.retry, isObj(retry) ? retry : {}));
      if (r.max === n.retry.max && r.delay === n.retry.delay) return false;
      n.retry = r;
      this._change("retry", [id]);
      return true;
    }

    convertWidget(id, name, toInput) {
      const n = this._byId.get(id);
      if (!n || n.missing) return false;
      const def = this._reg().get(n.type);
      const w = def && def.widgets.find(function (x) { return x.name === name; });
      if (!w || !w.convertible || def.inputs.some(function (s) { return s.name === name; })) return false;
      const has = n.converted.indexOf(name) >= 0;
      if (!!toInput === has) return false;
      if (toInput) n.converted.push(name);
      else {
        n.converted = n.converted.filter(function (x) { return x !== name; });
        this.links = this.links.filter(function (l) { return !(l.to === id && l.in === name); });
      }
      this._change("convert", [id]);
      return true;
    }

    // ----------------------------------------------------------------- slots
    slots(id) {
      const n = this._byId.get(id);
      if (!n) return { inputs: [], outputs: [] };
      const def = this._reg().get(n.type);
      if (!def) {
        const ms = n.missingSlots || { inputs: [], outputs: [] };
        return { inputs: ms.inputs.map(function (s) { return Object.assign({}, s); }), outputs: ms.outputs.map(function (s) { return Object.assign({}, s); }) };
      }
      const inputs = def.inputs.map(function (s) { return { name: s.name, type: s.type, label: s.label, optional: s.optional }; });
      def.widgets.forEach(function (w) {
        if (n.converted.indexOf(w.name) >= 0) {
          inputs.push({ name: w.name, type: w.type || KIND_TYPE[w.kind] || "STRING", label: w.label, optional: false, widget: true });
        }
      });
      const self = this;
      const outputs = def.outputs.map(function (s) {
        return { name: s.name, type: self._outType(id, s.name, s.type), label: s.label };
      });
      return { inputs: inputs, outputs: outputs };
    }

    _isPassthrough(def) { return !!(def && def.virtual && def.inputs.length); }

    /** Inputs whose upstream type a node's "*" outputs follow: reroute's first input or def.typeFrom. */
    _followInputs(def) {
      if (!def) return [];
      if (this._isPassthrough(def)) return [def.inputs[0].name];
      if (typeof def.typeFrom === "string") return [def.typeFrom];
      return Array.isArray(def.typeFrom) ? def.typeFrom : [];
    }
    _follows(def, inName) { return this._followInputs(def).indexOf(inName) >= 0; }

    /** Effective output type (reroute / approval / branch outputs take their upstream type). */
    _outType(id, outName, declared, seen) {
      const n = this._byId.get(id);
      const def = n && this._reg().get(n.type);
      const follow = this._followInputs(def);
      if (follow.length && (def.virtual || !declared || declared === "*")) {
        seen = seen || new Set();
        if (seen.has(id)) return declared || "*";
        seen.add(id);
        let link = null;
        for (let i = 0; i < follow.length && !link; i++) link = this.inputLink(id, follow[i]);
        if (!link) return declared || "*";
        const sdef = this.nodeDef(link.from);
        if (!sdef) return "*";
        const so = sdef.outputs.find(function (s) { return s.name === link.out; });
        return so ? this._outType(link.from, link.out, so.type, seen) : "*";
      }
      if (declared) return declared;
      const s = this.slots(id).outputs.find(function (x) { return x.name === outName; });
      return s ? s.type : "*";
    }

    inputLink(id, inName) {
      for (let i = 0; i < this.links.length; i++) {
        const l = this.links[i];
        if (l.to === id && l.in === inName) return l;
      }
      return null;
    }

    /** Resolve the real (non-virtual) producer of an input: {node, out, link} or null. */
    inputSource(id, inName, _seen) {
      const link = this.inputLink(id, inName);
      if (!link) return null;
      const src = this._byId.get(link.from);
      if (!src) return null;
      const def = this._reg().get(src.type);
      if (def && def.virtual) {
        if (!def.inputs.length) return null;
        const seen = _seen || new Set();
        if (seen.has(src.id)) return null;
        seen.add(src.id);
        return this.inputSource(src.id, def.inputs[0].name, seen);
      }
      return { node: src.id, out: link.out, link: link };
    }

    /** Final non-virtual consumers reached from a node's outputs through reroutes. */
    _consumers(id, seen) {
      seen = seen || new Set();
      if (seen.has(id)) return [];
      seen.add(id);
      const out = [];
      const self = this;
      this.links.forEach(function (l) {
        if (l.from !== id) return;
        const def = self.nodeDef(l.to);
        if (def && self._follows(def, l.in)) { self._consumers(l.to, seen).forEach(function (c) { out.push(c); }); return; }
        const s = self.slots(l.to).inputs.find(function (x) { return x.name === l.in; });
        out.push({ node: l.to, in: l.in, type: s ? s.type : "*" });
      });
      return out;
    }

    linksOf(id) { return this.links.filter(function (l) { return l.from === id || l.to === id; }); }

    _reaches(fromId, targetId) {
      const stack = [fromId], seen = new Set();
      while (stack.length) {
        const cur = stack.pop();
        if (cur === targetId) return true;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (let i = 0; i < this.links.length; i++) if (this.links[i].from === cur) stack.push(this.links[i].to);
      }
      return false;
    }

    canConnect(from, out, to, inp) {
      const a = this._byId.get(from), b = this._byId.get(to);
      if (!a || !b) return { ok: false, reason: "找不到要連接的節點。" };
      if (from === to) return { ok: false, reason: "節點不能連到自己。" };
      const os = this.slots(from).outputs.find(function (s) { return s.name === out; });
      if (!os) return { ok: false, reason: "找不到輸出埠「" + out + "」。" };
      const is = this.slots(to).inputs.find(function (s) { return s.name === inp; });
      if (!is) return { ok: false, reason: "找不到輸入埠「" + inp + "」。" };
      const T = this._types();
      const mismatch = function (o, i) {
        return { ok: false, reason: "類型不相容：「" + T.get(o).label + "」不能接「" + T.get(i).label + "」。" };
      };
      if (!T.compatible(os.type, is.type)) return mismatch(os.type, is.type);
      if (this._follows(this.nodeDef(to), inp)) {
        const cons = this._consumers(to);
        for (let i = 0; i < cons.length; i++) if (!T.compatible(os.type, cons[i].type)) return mismatch(os.type, cons[i].type);
      }
      const existing = this.inputLink(to, inp);
      if (existing && existing.from === from && existing.out === out) return { ok: true };
      if (this._reaches(to, from)) return { ok: false, reason: "不能循環連線，請改選其他輸入。" };
      return { ok: true };
    }

    connect(from, out, to, inp) {
      const chk = this.canConnect(from, out, to, inp);
      if (!chk.ok) { this.lastError = chk.reason; return null; }
      this.lastError = null;
      const existing = this.inputLink(to, inp);
      if (existing && existing.from === from && existing.out === out) return existing;
      if (existing) this.links = this.links.filter(function (l) { return l !== existing; });
      const link = { id: this._newId("l"), from: from, out: out, to: to, in: inp };
      this.links.push(link);
      this._change("connect", [from, to]);
      return link;
    }

    disconnect(linkId) {
      const l = this.links.find(function (x) { return x.id === linkId; });
      if (!l) return false;
      this.links = this.links.filter(function (x) { return x !== l; });
      this._change("disconnect", [l.from, l.to]);
      return true;
    }

    // ---------------------------------------------------------------- groups
    addGroup(rect) {
      const gr = this._normGroup(rect || {}, this._newId("g"));
      this.groups.push(gr);
      this._change("group", [gr.id]);
      return gr;
    }
    updateGroup(id, patch) {
      const gr = this.groups.find(function (x) { return x.id === id; });
      if (!gr || !isObj(patch)) return false;
      const nx = this._normGroup(Object.assign({}, gr, patch), id);
      if (stableStringify(nx) === stableStringify(gr)) return false;
      Object.assign(gr, nx);
      this._change("group", [id]);
      return true;
    }
    removeGroup(id) {
      const before = this.groups.length;
      this.groups = this.groups.filter(function (x) { return x.id !== id; });
      if (this.groups.length === before) return false;
      this._change("group", [id]);
      return true;
    }
    /** Node ids whose centre lies inside the group rectangle (h:0 counted as 80px). */
    nodesInGroup(id) {
      const gr = this.groups.find(function (x) { return x.id === id; });
      if (!gr) return [];
      return this.nodes.filter(function (n) {
        const cx = n.x + (n.w || 0) / 2, cy = n.y + (n.h || 80) / 2;
        return cx >= gr.x && cx <= gr.x + gr.w && cy >= gr.y && cy <= gr.y + gr.h;
      }).map(function (n) { return n.id; });
    }

    // ------------------------------------------------------------ execution
    order(targetIds) {
      const reg = this._reg();
      const self = this;
      let targets;
      if (Array.isArray(targetIds) && targetIds.length) targets = targetIds.filter(function (id) { return self._byId.has(id); });
      else {
        const outs = this.nodes.filter(function (n) { const d = reg.get(n.type); return d && d.output && !d.virtual; }).map(function (n) { return n.id; });
        targets = outs.length ? outs : this.nodes.map(function (n) { return n.id; });
      }
      const incoming = new Map();
      this.links.forEach(function (l) {
        if (!incoming.has(l.to)) incoming.set(l.to, []);
        incoming.get(l.to).push(l.from);
      });
      const need = new Set();
      const stack = targets.slice();
      while (stack.length) {
        const id = stack.pop();
        if (need.has(id) || !this._byId.has(id)) continue;
        need.add(id);
        (incoming.get(id) || []).forEach(function (f) { if (!need.has(f)) stack.push(f); });
      }
      const indeg = new Map(), outgoing = new Map();
      need.forEach(function (id) { indeg.set(id, 0); outgoing.set(id, []); });
      this.links.forEach(function (l) {
        if (need.has(l.from) && need.has(l.to)) { indeg.set(l.to, indeg.get(l.to) + 1); outgoing.get(l.from).push(l.to); }
      });
      const pos = new Map();
      this.nodes.forEach(function (n, i) { pos.set(n.id, i); });
      let ready = Array.from(need).filter(function (id) { return indeg.get(id) === 0; });
      const result = [];
      while (ready.length) {
        ready.sort(function (a, b) { return pos.get(a) - pos.get(b); });
        const id = ready.shift();
        result.push(id);
        outgoing.get(id).forEach(function (t) {
          indeg.set(t, indeg.get(t) - 1);
          if (indeg.get(t) === 0) ready.push(t);
        });
      }
      if (result.length < need.size) {
        const left = Array.from(need).filter(function (id) { return result.indexOf(id) < 0; });
        throw new CycleError(left.filter(function (id) { return self._inCycle(id); }));
      }
      return result.filter(function (id) { const d = self.nodeDef(id); return !(d && d.virtual); });
    }

    _inCycle(id) {
      const self = this;
      return this.links.some(function (l) { return l.from === id && self._reaches(l.to, id); });
    }

    _downstream(id) {
      const seen = new Set(), stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (let i = 0; i < this.links.length; i++) {
          const t = this.links[i].to;
          if (this.links[i].from === cur && !seen.has(t)) { seen.add(t); stack.push(t); }
        }
      }
      return seen;
    }
    _upstream(id) {
      const seen = new Set(), stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (let i = 0; i < this.links.length; i++) {
          const f = this.links[i].from;
          if (this.links[i].to === cur && !seen.has(f)) { seen.add(f); stack.push(f); }
        }
      }
      return seen;
    }

    /**
     * Loop analysis. A def with loopEnd:true is paired with the def.loopStart:true
     * node feeding its "loop" input. body = reachable from start AND reaching end.
     * -> {loops:[{startId,endId,body:Set,region:Set,parent:loop|null,depth}], issues:[...]}
     */
    loops() {
      const reg = this._reg();
      const self = this;
      const issues = [];
      const pairs = [];
      const endsByStart = new Map();
      this.nodes.forEach(function (n) {
        const d = reg.get(n.type);
        if (!d || !d.loopEnd) return;
        const src = self.inputSource(n.id, "loop");
        if (!src) return; // reported by validate() as a missing required input
        const sd = self.nodeDef(src.node);
        if (!sd || !sd.loopStart) { issues.push({ level: "error", nodeId: n.id, slot: "loop", message: "迴圈結束的「迴圈」輸入必須來自迴圈開始。" }); return; }
        if (!endsByStart.has(src.node)) endsByStart.set(src.node, []);
        endsByStart.get(src.node).push(n.id);
      });
      this.nodes.forEach(function (n) {
        const d = reg.get(n.type);
        if (!d || !d.loopStart) return;
        const ends = endsByStart.get(n.id) || [];
        if (!ends.length) { issues.push({ level: "warn", nodeId: n.id, message: "迴圈開始沒有對應的迴圈結束，只會執行一次。" }); return; }
        if (ends.length > 1) {
          ends.forEach(function (e) { issues.push({ level: "error", nodeId: e, message: "一個迴圈開始只能接一個迴圈結束。" }); });
          return;
        }
        pairs.push({ startId: n.id, endId: ends[0] });
      });
      const loops = pairs.map(function (p) {
        const down = self._downstream(p.startId), up = self._upstream(p.endId);
        const body = new Set();
        down.forEach(function (id) { if (up.has(id) && id !== p.startId && id !== p.endId) body.add(id); });
        const region = new Set(body);
        region.add(p.startId); region.add(p.endId);
        return { startId: p.startId, endId: p.endId, body: body, region: region, parent: null, depth: 1 };
      });
      const bad = new Set();
      for (let i = 0; i < loops.length; i++) {
        for (let j = i + 1; j < loops.length; j++) {
          const A = loops[i], B = loops[j];
          let overlap = false;
          A.region.forEach(function (id) { if (B.region.has(id)) overlap = true; });
          if (!overlap) continue;
          const inA = Array.from(B.region).every(function (id) { return A.body.has(id); });
          const inB = Array.from(A.region).every(function (id) { return B.body.has(id); });
          if (!inA && !inB) { bad.add(A); bad.add(B); }
        }
      }
      bad.forEach(function (L) {
        [L.startId, L.endId].forEach(function (id) { issues.push({ level: "error", nodeId: id, message: "迴圈區段交錯：請讓迴圈完整包含或完全分開。" }); });
      });
      const good = loops.filter(function (L) { return !bad.has(L); });
      good.forEach(function (L) {
        let best = null;
        good.forEach(function (P) {
          if (P === L || !P.body.has(L.startId) || !P.body.has(L.endId)) return;
          if (!best || best.body.size > P.body.size) best = P;
        });
        L.parent = best;
      });
      good.forEach(function (L) {
        let d = 1, p = L.parent;
        while (p && d < 10) { d++; p = p.parent; }
        L.depth = d;
        if (d > 3) issues.push({ level: "error", nodeId: L.endId, message: "迴圈巢狀超過 3 層。" });
      });
      return { loops: good, issues: issues };
    }

    validate() {
      const issues = this.loops().issues.slice();
      const reg = this._reg(), T = this._types();
      const self = this;
      const outputs = this.nodes.filter(function (n) { const d = reg.get(n.type); return d && d.output && !d.virtual; });
      let feeds = null;
      if (outputs.length) {
        feeds = new Set();
        const stack = outputs.map(function (n) { return n.id; });
        while (stack.length) {
          const id = stack.pop();
          if (feeds.has(id)) continue;
          feeds.add(id);
          this.links.forEach(function (l) { if (l.to === id) stack.push(l.from); });
        }
      }
      this.nodes.forEach(function (n) {
        const def = reg.get(n.type);
        if (!def) {
          issues.push({ level: "error", nodeId: n.id, message: "找不到節點類型「" + n.type + "」，請確認對應的節點已載入。" });
          return;
        }
        if (self._inCycle(n.id)) issues.push({ level: "error", nodeId: n.id, message: "循環連線：請移除其中一條連線。" });
        if (def.virtual) return;
        if (n.mode === "normal") {
          self.slots(n.id).inputs.forEach(function (s) {
            if (s.optional) return;
            if (!self.inputSource(n.id, s.name)) issues.push({ level: "error", nodeId: n.id, slot: s.name, message: "缺少必要輸入「" + s.label + "」。" });
          });
        }
        if (feeds && !feeds.has(n.id)) issues.push({ level: "warn", nodeId: n.id, message: "此節點沒有連到任何輸出節點，執行時會略過。" });
        if (typeof def.validate === "function") {
          let extra = [];
          try { extra = def.validate(n, self) || []; } catch (e) { extra = [{ level: "error", message: String(e && e.message || e) }]; }
          extra.forEach(function (x) { issues.push(Object.assign({ level: "error", nodeId: n.id }, x)); });
        }
      });
      this.links.forEach(function (l) {
        const def = self.nodeDef(l.to);
        if (!def || self._follows(def, l.in)) return;
        const os = self.slots(l.from).outputs.find(function (s) { return s.name === l.out; });
        const is = self.slots(l.to).inputs.find(function (s) { return s.name === l.in; });
        if (os && is && !T.compatible(os.type, is.type)) {
          issues.push({ level: "warn", nodeId: l.to, slot: l.in, message: "類型不相容：「" + T.get(os.type).label + "」不能接「" + T.get(is.type).label + "」。" });
        }
      });
      return issues;
    }

    // ------------------------------------------------------------- clipboard
    copy(ids) {
      const set = new Set(toIds(ids).filter((id) => this._byId.has(id)));
      const self = this;
      const nodes = this.nodes.filter(function (n) { return set.has(n.id); }).map(function (n) { return self._nodeJSON(n, true); });
      const links = this.links.filter(function (l) { return set.has(l.from) && set.has(l.to); }).map(function (l) { return self._linkJSON(l); });
      let minX = Infinity, minY = Infinity;
      nodes.forEach(function (n) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); });
      return { schema: "sea-agent-studio/clip", version: 1, nodes: nodes, links: links, origin: { x: nodes.length ? minX : 0, y: nodes.length ? minY : 0 } };
    }

    paste(clip, pos) {
      if (typeof clip === "string") { try { clip = JSON.parse(clip); } catch (e) { return []; } }
      if (!isObj(clip) || !Array.isArray(clip.nodes) || !clip.nodes.length) return [];
      const self = this;
      const warn = function (m) { self.warnings.push(m); };
      let origin = isObj(clip.origin) ? { x: num(clip.origin.x, 0), y: num(clip.origin.y, 0) } : null;
      if (!origin) {
        let mx = Infinity, my = Infinity;
        clip.nodes.forEach(function (n) { if (isObj(n)) { mx = Math.min(mx, num(n.x, 0)); my = Math.min(my, num(n.y, 0)); } });
        origin = { x: Number.isFinite(mx) ? mx : 0, y: Number.isFinite(my) ? my : 0 };
      }
      const dx = pos && Number.isFinite(Number(pos.x)) ? Number(pos.x) - origin.x : 24;
      const dy = pos && Number.isFinite(Number(pos.y)) ? Number(pos.y) - origin.y : 24;
      const map = new Map();
      const added = [];
      clip.nodes.forEach(function (raw) {
        const n = self._normNode(raw, warn);
        if (!n) return;
        const oldId = n.id;
        n.id = self._newId("n");
        n.x += dx; n.y += dy;
        if (oldId) map.set(oldId, n.id);
        self.nodes.push(n);
        self._byId.set(n.id, n);
        added.push(n.id);
      });
      if (!added.length) return [];
      const taken = new Set(this.links.map(function (l) { return l.to + "\u0000" + l.in; }));
      (Array.isArray(clip.links) ? clip.links : []).forEach(function (l) {
        if (!isObj(l) || !map.has(l.from) || !map.has(l.to)) return;
        const nl = { id: null, from: map.get(l.from), out: String(l.out), to: map.get(l.to), in: String(l.in) };
        if (!self._acceptLink(nl, warn, taken)) return;
        nl.id = self._newId("l");
        self.links.push(nl);
      });
      this._change("paste", added);
      return added;
    }
  }

  SG.version = "0.6.0";
  SG.Emitter = Emitter;
  SG.CycleError = CycleError;
  SG.types = types;
  SG.registry = registry;
  SG.Graph = Graph;
  SG.hash = hash;
  SG.stableStringify = stableStringify;
  SG.previewText = function (v) { return isInactive(v) ? "" : previewText(v); };
  SG.INACTIVE = INACTIVE;
  SG.isInactive = isInactive;
  SG.control = {
    CONDITION_MODES: CONDITION_MODES,
    conditionWidgets: conditionWidgets,
    evalCondition: evalCondition,
    truthy: truthy,
    text: condText,
    normRetry: normRetry,
    MAX_LOOP: 20,
    MAX_LOOP_DEPTH: 3
  };
  SG.SCHEMA = SCHEMA;
})(globalThis);
