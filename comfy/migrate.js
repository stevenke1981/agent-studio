/* 小海 Agent 工作室 — v0.5 flow migration and workflow import (DOM-free, pure).
 * Requires comfy/nodes.js (SG.nodes.spec) to be loaded first. */
(function (root) {
  "use strict";
  const SG = root.SeaGraph = root.SeaGraph || {};
  const M = SG.migrate = SG.migrate || {};
  M.SCHEMA = "sea-agent-studio/workflow";
  M.VERSION = 1;
  M.scale = { x: 1.4, y: 1.3 };

  function spec() {
    if (!SG.nodes || !SG.nodes.byKind) throw new Error("migrate.js 需要先載入 comfy/nodes.js。");
    return SG.nodes;
  }
  function num(id) { const m = /^[a-z]+([0-9]+)$/.exec(String(id)); return m ? Number(m[1]) : 0; }

  /** The v0.5 base(name) graph, rebuilt from the duplicated preset table. */
  M.v05Base = function v05Base(name) {
    const N = spec();
    const rows = N.v05Presets[name];
    if (!rows) throw new Error("沒有這個流程範例：" + name);
    const list = rows.map(([kind, x, y], idx) => ({ id: "n" + (idx + 1), kind, x, y, value: N.byKind[kind].widget ? N.byKind[kind].widget.default : "" }));
    return { name, nodes: list, edges: list.slice(1).map((n, i) => [list[i].id, n.id]), next: list.length + 1 };
  };

  /** Old v0.5 graph {name,nodes:[{id,kind,x,y,value,agentRef?}],edges:[[a,b]],next} -> workflow JSON. */
  M.fromV05 = function fromV05(old, agentId) {
    const N = spec();
    if (typeof old === "string") { try { old = JSON.parse(old); } catch (e) { return null; } }
    if (!old || typeof old !== "object" || !Array.isArray(old.nodes)) return null;
    const nodes = [], seen = new Map();
    for (const n of old.nodes) {
      const s = n && N.byKind[n.kind];
      if (!s || typeof n.id !== "string" || !n.id || seen.has(n.id)) continue;
      const widgets = {};
      if (s.widget) widgets[s.widget.name] = typeof n.value === "string" ? n.value : s.widget.default;
      const props = {};
      if (n.agentRef != null && n.agentRef !== "") props.agentRef = String(n.agentRef);
      const node = {
        id: n.id, type: s.type,
        x: Math.round((Number.isFinite(n.x) ? n.x : 20) * M.scale.x),
        y: Math.round((Number.isFinite(n.y) ? n.y : 24) * M.scale.y),
        w: 220, h: 0, title: null, mode: "normal", collapsed: false,
        widgets, converted: [], props
      };
      nodes.push(node); seen.set(n.id, s);
    }
    const links = [], taken = new Set();
    for (const e of Array.isArray(old.edges) ? old.edges : []) {
      if (!Array.isArray(e) || e.length < 2) continue;
      const a = seen.get(e[0]), b = seen.get(e[1]);
      if (!a || !b || !b.input || e[0] === e[1]) continue;
      if (a.output.type !== b.input.type) continue;
      const key = e[1] + "." + b.input.name;
      if (taken.has(key)) continue;
      taken.add(key);
      links.push({ id: "l" + (links.length + 1), from: e[0], out: a.output.name, to: e[1], in: b.input.name });
    }
    const maxNode = nodes.reduce((m, n) => Math.max(m, num(n.id)), 0);
    return {
      schema: M.SCHEMA, version: M.VERSION, agent: agentId != null ? agentId : null,
      nodes, links, groups: [], view: { x: 0, y: 0, k: 1 },
      next: Math.max(Number.isInteger(old.next) ? old.next : 0, maxNode + 1, links.length + 1)
    };
  };

  /** Built-in presets as workflows: rust / research / go / java / empty (v0.5)
   *  plus the control-flow demos branch / fix-loop / retry (Amendment 2). */
  M.presetNames = ["rust", "research", "go", "java", "empty", "branch", "fix-loop", "retry"];
  M.presetTitles = { rust: "搜尋 → Rust", research: "搜尋與引用", go: "Go 編譯與測試", java: "Java 編譯與測試", empty: "空白畫布",
    branch: "條件分支", "fix-loop": "修正直到通過", retry: "重試示範" };

  function build(agentId, nodes, links) {
    const list = nodes.map(([id, type, x, y, widgets, extra]) => Object.assign({
      id, type, x, y, w: 220, h: 0, title: null, mode: "normal", collapsed: false,
      widgets: widgets || {}, converted: [], props: {} }, extra || {}));
    const ls = links.map(([from, out, to, inp], i) => ({ id: "l" + (i + 1), from, out, to, in: inp }));
    return { schema: M.SCHEMA, version: M.VERSION, agent: agentId != null ? agentId : null,
      nodes: list, links: ls, groups: [], view: { x: 0, y: 0, k: 1 }, next: Math.max(list.length, ls.length) + 1 };
  }
  const controlPresets = {
    // query -> condition(contains "Rust") -> branch -> Rust path / research path -> merge -> preview
    branch: agentId => build(agentId, [
      ["n1", "search/query", 20, 200, { query: "Rust 測試" }],
      ["n2", "core/condition", 300, 60, { mode: "contains", pattern: "Rust", negate: false }],
      ["n3", "core/branch", 580, 200, {}],
      ["n4", "search/read", 860, 20, {}],
      ["n5", "search/cite", 1140, 20, { purpose: "給 Coding 專才參考" }],
      ["n6", "code/rust-read", 1420, 20, { workdir: "/demo/worktrees/rust" }],
      ["n7", "code/rust-build", 1700, 20, { command: "cargo build" }],
      ["n8", "code/rust-test", 1980, 20, { command: "cargo test", flaky: 0 }],
      ["n9", "search/read", 860, 400, {}],
      ["n10", "search/cite", 1140, 400, { purpose: "研究交接" }],
      ["n11", "core/merge", 2260, 200, {}],
      ["n12", "core/preview", 2540, 200, {}]
    ], [
      ["n1", "query", "n2", "value"], ["n1", "query", "n3", "value"], ["n2", "result", "n3", "condition"],
      ["n3", "true", "n4", "query"], ["n4", "sources", "n5", "sources"], ["n5", "summary", "n6", "summary"],
      ["n6", "project", "n7", "project"], ["n7", "build", "n8", "build"], ["n8", "report", "n11", "a"],
      ["n3", "false", "n9", "query"], ["n9", "sources", "n10", "sources"], ["n10", "summary", "n11", "b"],
      ["n11", "value", "n12", "value"]
    ]),
    // loop-start -> build -> test(flaky) -> fix -> loop-end (done when text contains 通過, max 3)
    "fix-loop": agentId => build(agentId, [
      ["n1", "code/rust-read", 20, 80, { workdir: "/demo/worktrees/rust" }],
      ["n2", "core/loop-start", 300, 80, { max: 3 }],
      ["n3", "code/rust-build", 580, 80, { command: "cargo build" }],
      ["n4", "code/rust-test", 860, 80, { command: "cargo test", flaky: 1 }],
      ["n5", "code/rust-fix", 1140, 80, { note: "依測試報告修正" }],
      ["n6", "core/loop-end", 1420, 80, { mode: "contains", pattern: "通過", negate: false }],
      ["n7", "core/preview", 1700, 80, {}]
    ], [
      ["n1", "project", "n2", "init"], ["n2", "value", "n3", "project"], ["n3", "build", "n4", "build"],
      ["n4", "report", "n5", "report"], ["n5", "project", "n6", "value"], ["n2", "loop", "n6", "loop"],
      ["n6", "result", "n7", "value"]
    ]),
    // test with flaky=2 and a retry policy of max 3
    retry: agentId => build(agentId, [
      ["n1", "code/rust-read", 20, 80, { workdir: "/demo/worktrees/rust" }],
      ["n2", "code/rust-build", 300, 80, { command: "cargo build" }],
      ["n3", "code/rust-test", 580, 80, { command: "cargo test", flaky: 2 }, { retry: { max: 3, delay: 300 } }]
    ], [
      ["n1", "project", "n2", "project"], ["n2", "build", "n3", "build"]
    ])
  };
  M.preset = function preset(name, agentId) {
    if (Object.prototype.hasOwnProperty.call(controlPresets, name)) return controlPresets[name](agentId);
    return M.fromV05(M.v05Base(name), agentId != null ? agentId : null);
  };
  /** Preset name used for an agent id when nothing is stored. */
  M.presetFor = function presetFor(agentId) {
    if (agentId === "offline-rust-review") return "rust";
    return M.presetNames.indexOf(agentId) >= 0 ? agentId : "empty";
  };

  function normalize(v, agentId) {
    const w = JSON.parse(JSON.stringify(v));
    w.schema = M.SCHEMA; w.version = M.VERSION;
    if (!Array.isArray(w.nodes)) w.nodes = [];
    if (!Array.isArray(w.links)) w.links = [];
    if (!Array.isArray(w.groups)) w.groups = [];
    if (!w.view || typeof w.view !== "object") w.view = { x: 0, y: 0, k: 1 };
    if (!Number.isInteger(w.next)) {
      const ids = w.nodes.concat(w.links, w.groups).map(x => num(x && x.id));
      w.next = Math.max(0, ...ids) + 1;
    }
    if (agentId != null) w.agent = agentId;
    else if (w.agent === undefined) w.agent = null;
    return w;
  }
  M.normalize = normalize;

  /** Accepts workflow JSON, an old v0.5 graph, or an old export {schema_version:1, graph}. */
  M.importAny = function importAny(input, agentId) {
    let v = input;
    if (typeof v === "string") {
      try { v = JSON.parse(v.replace(/^﻿/, "")); } catch (e) { throw new Error("不是有效的 JSON 檔案。"); }
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("無法辨識的流程檔案。");
    if (v.schema === M.SCHEMA) {
      if (v.version !== M.VERSION) throw new Error("不支援的流程版本：" + v.version);
      if (!Array.isArray(v.nodes)) throw new Error("流程檔案缺少 nodes。");
      return normalize(v, agentId);
    }
    if (v.schema_version === 1 && v.graph && typeof v.graph === "object") {
      const w = M.fromV05(v.graph, agentId);
      if (!w) throw new Error("v0.5 匯出檔的 graph 格式不正確。");
      return w;
    }
    if (Array.isArray(v.nodes) && Array.isArray(v.edges)) {
      const w = M.fromV05(v, agentId);
      if (!w) throw new Error("v0.5 流程格式不正確。");
      return w;
    }
    throw new Error("無法辨識的流程檔案：需要 workflow JSON、v0.5 流程或 v0.5 匯出檔。");
  };
})(globalThis);
