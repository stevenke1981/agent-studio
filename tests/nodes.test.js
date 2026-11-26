// node tests/nodes.test.js — domain nodes, migration, run history.
"use strict";
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");

const dir = path.join(__dirname, "..", "comfy");
const file = name => path.join(dir, name);
const engineMissing = !fs.existsSync(file("graph.js"));
if (engineMissing) console.log("SKIP: engine not merged yet (engine section skipped; engine-free section still runs)");

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok   " + name); }
  catch (e) { failures.push(name); console.log("FAIL " + name + "\n     " + (e && e.stack || e)); }
}
function load(name) { const p = file(name); delete require.cache[require.resolve(p)]; require(p); }

// Old v0.5 base(), rebuilt independently of migrate.js.
const parts = {
  query: "Rust 測試", read: "", cite: "給 Coding 專才參考",
  "rust-read": "/demo/worktrees/rust", "rust-build": "cargo build", "rust-test": "cargo test"
};
const oldPresets = {
  rust: [["query", 20, 24], ["read", 219, 24], ["cite", 419, 24], ["rust-read", 20, 244], ["rust-build", 219, 244], ["rust-test", 419, 244]]
};
function base(name) {
  const list = oldPresets[name].map(([kind, x, y], idx) => ({ id: "n" + (idx + 1), kind, x, y, value: parts[kind] || "" }));
  return { name, nodes: list, edges: list.slice(1).map((n, i) => [list[i].id, n.id]), next: list.length + 1 };
}

async function pure() {
  load("nodes.js"); load("migrate.js"); load("runs.js");
  const SG = globalThis.SeaGraph;

  await test("fromV05(base('rust')) shape: 6 nodes / 5 links, slot names", () => {
    const w = SG.migrate.fromV05(base("rust"), "rust");
    assert.equal(w.schema, "sea-agent-studio/workflow");
    assert.equal(w.version, 1);
    assert.equal(w.agent, "rust");
    assert.equal(w.nodes.length, 6);
    assert.equal(w.links.length, 5);
    assert.deepEqual(w.nodes.map(n => n.type), ["search/query", "search/read", "search/cite", "code/rust-read", "code/rust-build", "code/rust-test"]);
    assert.deepEqual(w.nodes[0].widgets, { query: "Rust 測試" });
    assert.deepEqual(w.nodes[1].widgets, {});
    assert.deepEqual(w.nodes[4].widgets, { command: "cargo build" });
    assert.deepEqual(w.links[0], { id: "l1", from: "n1", out: "query", to: "n2", in: "query" });
    assert.deepEqual(w.links.map(l => l.out + ">" + l.in), ["query>query", "sources>sources", "summary>summary", "project>project", "build>build"]);
    for (const n of w.nodes) {
      assert.equal(n.mode, "normal"); assert.equal(n.collapsed, false); assert.deepEqual(n.converted, []);
      assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y)); assert.equal(n.w, 220); assert.equal(n.h, 0);
    }
    assert.ok(w.next >= 7);
    assert.deepEqual(w.view, { x: 0, y: 0, k: 1 });
    assert.deepEqual(w.groups, []);
  });

  await test("fromV05 keeps agentRef in props, drops bad kinds and incompatible edges", () => {
    const w = SG.migrate.fromV05({ name: "empty", nodes: [
      { id: "n1", kind: "go-read", x: 1, y: 2, value: "/x", agentRef: "go" },
      { id: "n2", kind: "nope", x: 1, y: 2, value: "" },
      { id: "n3", kind: "rust-build", x: 1, y: 2, value: "cargo build" }
    ], edges: [["n1", "n2"], ["n1", "n3"]], next: 4 });
    assert.equal(w.nodes.length, 2);
    assert.deepEqual(w.nodes[0].props, { agentRef: "go" });
    assert.equal(w.links.length, 0, "PROJECT_GO must not link into Rust build");
    assert.equal(SG.migrate.fromV05(null), null);
    assert.equal(SG.migrate.fromV05({ nope: 1 }), null);
  });

  await test("presets counts 6/3/3/3/0 and links 5/2/2/2/0", () => {
    const counts = ["rust", "research", "go", "java", "empty"].map(n => SG.migrate.preset(n));
    assert.deepEqual(counts.map(w => w.nodes.length), [6, 3, 3, 3, 0]);
    assert.deepEqual(counts.map(w => w.links.length), [5, 2, 2, 2, 0]);
    assert.equal(SG.migrate.presetFor("offline-rust-review"), "rust");
    assert.equal(SG.migrate.presetFor("custom-abc"), "empty");
  });

  await test("importAny: workflow JSON, v0.5 graph, v0.5 export payload, garbage", () => {
    const wf = SG.migrate.preset("go", "go");
    const a = SG.migrate.importAny(JSON.stringify(wf));
    assert.equal(a.nodes.length, 3); assert.equal(a.agent, "go");
    const b = SG.migrate.importAny(base("rust"), "rust");
    assert.equal(b.nodes.length, 6); assert.equal(b.links.length, 5);
    const c = SG.migrate.importAny({ schema_version: 1, mode: "demo_only", graph: base("rust"), preview: [] }, "x");
    assert.equal(c.nodes.length, 6); assert.equal(c.agent, "x");
    assert.throws(() => SG.migrate.importAny("{not json"), /不是有效的 JSON/);
    assert.throws(() => SG.migrate.importAny({ hello: 1 }), /無法辨識/);
    assert.throws(() => SG.migrate.importAny({ schema: "sea-agent-studio/workflow", version: 9, nodes: [] }), /不支援/);
    assert.equal(JSON.stringify(SG.migrate.importAny(wf)), JSON.stringify(SG.migrate.importAny(wf)));
  });

  await test("permissionIssues: write tool into read-only agent is an error", () => {
    const profiles = new Map([["a1", { id: "a1", name: "審查員", tool_refs: [{ id: "file-access", operations: ["read"] }] }]]);
    const g = { nodes: [
      { id: "n1", type: "tool/file-access", widgets: { operation: "寫入檔案" } },
      { id: "n2", type: "agent/a1", widgets: {} },
      { id: "n3", type: "tool/file-access", widgets: { operation: "讀取檔案" } },
      { id: "n4", type: "agent/a1", widgets: {} }
    ], links: [
      { id: "l1", from: "n1", out: "tool", to: "n2", in: "tool" },
      { id: "l2", from: "n3", out: "tool", to: "n4", in: "tool" }
    ] };
    const issues = SG.nodes.permissionIssues(g, profiles);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].level, "error"); assert.equal(issues[0].nodeId, "n2"); assert.match(issues[0].message, /寫入/);
    profiles.get("a1").tool_refs[0].operations.push("write");
    assert.equal(SG.nodes.permissionIssues(g, profiles).length, 0);
    // configurationCheck reuse path
    const viaCheck = SG.nodes.permissionIssues(g, new Map([["a1", { id: "a1", name: "x", tool_refs: [] }]]), {
      configurationCheck: () => ({ toolReview: [{ id: "file-access", name: "檔案", checks: { read: true, write: false } }] })
    });
    assert.deepEqual(viaCheck.map(i => i.level), ["error"]);
  });

  await test("domain execute (stub registry) reproduces simulate() texts", async () => {
    const defs = {};
    const stub = { types: { _t: {}, define(id, d) { this._t[id] = d; }, get(id) { return this._t[id]; } },
      registry: { register(d) { defs[d.type] = d; }, get(t) { return defs[t]; }, unregister(t) { delete defs[t]; }, list() { return Object.values(defs); } } };
    SG.nodes.registerAll(stub);
    const ctx = (id, widgets) => ({ node: { id, widgets, props: {} }, widgets, progress() {}, log() {}, signal: { aborted: false } });
    const q = await defs["search/query"].execute({}, ctx("n1", { query: " Rust 測試 " }));
    assert.deepEqual(q, { query: { text: "已準備查詢：Rust 測試", query: "Rust 測試", producedBy: "n1" } });
    await assert.rejects(defs["search/query"].execute({}, ctx("n1", { query: "  " })), { message: "查詢詞不能留白" });
    const r = await defs["search/read"].execute({ query: q.query }, ctx("n2", {}));
    assert.equal(r.sources.text, "本機索引找到 3 筆官方文件");
    await assert.rejects(defs["search/read"].execute({ query: { query: "xyzzy" } }, ctx("n2", {})), { message: "預載索引沒有命中，請換關鍵字" });
    await assert.rejects(defs["search/read"].execute({}, ctx("n2", {})), { message: "缺少輸入：查詢詞" });
    const c = await defs["search/cite"].execute({ sources: r.sources }, ctx("n3", { purpose: "" }));
    assert.equal(c.summary.text, "研究交接：整理 3 筆引用");
    const rr = await defs["code/rust-read"].execute({}, ctx("n4", { workdir: "/w" }));
    assert.deepEqual(rr, { project: { text: "套用 Rust 示範目錄 /w", producedBy: "n4" } });
    await assert.rejects(defs["code/go-read"].execute({}, ctx("n4", { workdir: "" })), { message: "請設定示範工作目錄" });
    const b = await defs["code/rust-build"].execute({ project: rr.project }, ctx("n5", { command: "cargo build" }));
    assert.equal(b.build.text, "模擬「cargo build」 · 真實執行 NOT_RUN");
    await assert.rejects(defs["code/rust-test"].execute({ build: b.build }, ctx("n6", { command: "" })), { message: "請設定示範指令" });
    await assert.rejects(defs["code/java-build"].execute({}, ctx("n6", { command: "mvn" })), { message: "缺少輸入：Java 專案" });
    assert.equal(defs["code/rust-build"].estimate({ command: "x" }).writes, true);
    assert.equal(stub.types._t.PROJECT_RUST.label, "Rust 專案");
    assert.equal(stub.types._t.REPORT.label, "測試報告");
    const types = SG.nodes.syncCatalog({
      profiles: new Map([["rust", { id: "rust", name: "Rust 開發", tool_refs: [] }]]),
      skills: new Map([["s1", { id: "s1", description: "d" }]]),
      tools: new Map([["file-access", { id: "file-access", name: "檔案存取", operations: ["read", "write"] }]])
    });
    assert.deepEqual(types.sort(), ["agent/rust", "skill/s1", "tool/file-access"]);
    assert.match(defs["tool/file-access"].hint, /［讀］［寫］/);
    SG.nodes.syncCatalog({ profiles: [], skills: [], tools: [] });
    assert.equal(defs["agent/rust"], undefined, "stale catalogue nodes are unregistered");
  });

  await test("control-flow presets: branch / fix-loop / retry shapes", () => {
    const br = SG.migrate.preset("branch", "rust"), lp = SG.migrate.preset("fix-loop"), rt = SG.migrate.preset("retry");
    assert.deepEqual([br.nodes.length, br.links.length], [12, 13]);
    assert.deepEqual([lp.nodes.length, lp.links.length], [7, 7]);
    assert.deepEqual([rt.nodes.length, rt.links.length], [3, 2]);
    assert.ok(br.nodes.some(n => n.type === "core/branch") && br.nodes.some(n => n.type === "core/merge"));
    assert.equal(lp.nodes.find(n => n.type === "core/loop-end").widgets.pattern, "通過");
    assert.equal(lp.links.find(l => l.out === "loop").in, "loop");
    assert.deepEqual(rt.nodes[2].retry, { max: 3, delay: 300 });
    assert.equal(rt.nodes[2].widgets.flaky, 2);
    for (const w of [br, lp, rt]) {
      const ids = new Set(w.nodes.map(n => n.id));
      assert.ok(w.links.every(l => ids.has(l.from) && ids.has(l.to)));
      assert.ok(w.next > w.nodes.length);
    }
  });

  await test("flaky test + fix node (stub ctx.attempt / ctx.iteration)", async () => {
    const defs = {};
    const stub = { types: { _t: {}, define(id, d) { this._t[id] = d; }, get(id) { return this._t[id]; } },
      registry: { register(d) { defs[d.type] = d; }, get(t) { return defs[t]; }, unregister(t) { delete defs[t]; }, list() { return Object.values(defs); } } };
    SG.nodes.registerAll(stub);
    const ctx = (widgets, extra) => Object.assign({ node: { id: "t", widgets, props: {} }, widgets, progress() {}, signal: { aborted: false } }, extra);
    const build = { text: "b" };
    const w = { command: "cargo test", flaky: 2 };
    await assert.rejects(defs["code/rust-test"].execute({ build }, ctx(w, { attempt: 0 })), { message: "測試暫時失敗（模擬）" });
    await assert.rejects(defs["code/rust-test"].execute({ build }, ctx(w, { attempt: 1 })), { message: "測試暫時失敗（模擬）" });
    const ok = await defs["code/rust-test"].execute({ build }, ctx(w, { attempt: 2 }));
    assert.equal(ok.report.text, "模擬「cargo test」 · 真實執行 NOT_RUN");
    const soft = await defs["code/rust-test"].execute({ build }, ctx({ command: "x", flaky: 1 }, { attempt: 0, iteration: { index: 0, max: 3 } }));
    assert.equal(soft.report.failed, true);
    const fixed = await defs["code/rust-fix"].execute({ report: soft.report }, ctx({ note: "" }));
    assert.doesNotMatch(fixed.project.text, /通過/);
    const pass = await defs["code/rust-test"].execute({ build }, ctx({ command: "x", flaky: 1 }, { attempt: 0, iteration: { index: 1, max: 3 } }));
    const done = await defs["code/rust-fix"].execute({ report: pass.report }, ctx({ note: "" }));
    assert.match(done.project.text, /通過/);
    assert.ok(defs["code/go-fix"] && defs["code/java-fix"]);
    assert.equal(defs["code/java-fix"].outputs[0].type, "PROJECT_JAVA");
    assert.equal(defs["code/rust-test"].widgets.find(x => x.name === "flaky").default, 0);
  });

  await test("runs.record + runs.diff", () => {
    const snap1 = SG.migrate.preset("research", "research");
    const snap2 = JSON.parse(JSON.stringify(snap1));
    snap2.nodes[0].widgets.query = "xyzzy";
    snap2.nodes.push({ id: "n9", type: "core/note", widgets: {} });
    snap2.nodes = snap2.nodes.filter(n => n.id !== "n3");
    const r1 = { runId: 1, status: "ok", order: ["n1", "n2", "n3"], snapshot: snap1, results: [
      { id: "n1", status: "done", text: "已準備查詢：Rust 測試", outputs: { query: { text: "已準備查詢：Rust 測試" } }, key: "k1", ms: 3 },
      { id: "n2", status: "done", text: "本機索引找到 3 筆官方文件", outputs: {}, key: "k2", ms: 2 },
      { id: "n3", status: "done", text: "x", outputs: { summary: { text: "x", sources: [{ title: "t", url: "u", terms: "z" }] } } }] };
    const r2 = { runId: 2, status: "error", order: ["n1", "n2"], snapshot: snap2, results: [
      { id: "n1", status: "done", text: "已準備查詢：xyzzy", outputs: {} },
      { id: "n2", status: "error", text: "預載索引沒有命中，請換關鍵字", outputs: {} }] };
    const a = SG.runs.record(r1, { agent: "research", at: "2026-11-26T00:00:00.000Z" });
    const b = SG.runs.record(r2, { agent: "research", at: "2026-11-26T00:01:00.000Z" });
    assert.deepEqual(Object.keys(a).sort(), ["agent", "at", "id", "order", "results", "snapshot", "status"]);
    assert.equal(a.agent, "research"); assert.equal(a.status, "ok"); assert.deepEqual(a.order, ["n1", "n2", "n3"]);
    assert.deepEqual(a.results[2].sources, [{ title: "t", url: "u" }]);
    assert.equal(a.results[0].key, "k1");
    assert.notEqual(a.snapshot, snap1, "snapshot is copied");
    assert.deepEqual(SG.runs.counts(b), { done: 1, cached: 0, error: 1, skipped: 0, waiting: 0, total: 2 });
    const d = SG.runs.diff(a, b);
    const by = Object.fromEntries(d.map(x => [x.id, x]));
    assert.equal(by.n1.change, "changed"); assert.deepEqual(by.n1.widgetsChanged, ["query"]);
    assert.equal(by.n2.change, "changed"); assert.equal(by.n2.statusBefore, "done"); assert.equal(by.n2.statusAfter, "error");
    assert.equal(by.n3.change, "removed");
    assert.equal(by.n9.change, "added");
    assert.ok(SG.runs.diff(a, a).every(x => x.change === "same"));
    let list = [];
    for (let i = 0; i < 25; i++) list = SG.runs.push(list, SG.runs.record(r1, { agent: "r", at: "t" + i }));
    assert.equal(list.length, 20); assert.equal(list[0].at, "t24");
  });
}

async function engine() {
  for (const f of ["graph.js", "executor.js", "core-nodes.js", "nodes.js", "migrate.js", "runs.js"]) load(f);
  const SG = globalThis.SeaGraph;
  SG.nodes.registerAll(SG);
  const fast = () => Promise.resolve();
  const runWorkflow = async (json, mutate) => {
    const g = new SG.Graph(json);
    if (mutate) mutate(g);
    const ex = new SG.Executor(g, { registry: SG.registry, delay: fast });
    const res = await ex.queue({ targets: g.nodes.map(n => n.id) });
    return { g, ex, res };
  };
  const byId = res => Object.fromEntries(res.results.map(r => [r.id, r]));

  await test("engine: fromV05(base('rust')) runs 6/6", async () => {
    const { res } = await runWorkflow(SG.migrate.fromV05(base("rust"), "rust"));
    assert.equal(res.results.length, 6);
    assert.equal(res.results.filter(r => r.status === "done").length, 6, JSON.stringify(res.results.map(r => [r.id, r.status, r.text])));
    assert.equal(res.status, "ok");
  });

  await test("engine: second queue is all cached", async () => {
    const { ex, g } = await runWorkflow(SG.migrate.preset("rust", "rust"));
    const again = await ex.queue({ targets: g.nodes.map(n => n.id) });
    assert.ok(again.results.every(r => r.status === "cached"));
  });

  await test("engine: empty query -> 「查詢詞不能留白」", async () => {
    const { res } = await runWorkflow(SG.migrate.preset("rust"), g => g.setWidget("n1", "query", "   "));
    const r = byId(res);
    assert.equal(r.n1.status, "error");
    assert.match(String(r.n1.text), /查詢詞不能留白/);
    for (const id of ["n2", "n3", "n4", "n5", "n6"]) assert.ok(["skipped", "error"].includes(r[id].status), id + " " + r[id].status);
  });

  await test("engine: unmatched keyword blocks downstream", async () => {
    const { res } = await runWorkflow(SG.migrate.preset("rust"), g => g.setWidget("n1", "query", "xyzzy"));
    const r = byId(res);
    assert.equal(r.n1.status, "done");
    assert.equal(r.n2.status, "error");
    assert.match(String(r.n2.text), /預載索引沒有命中，請換關鍵字/);
    for (const id of ["n3", "n4", "n5", "n6"]) assert.ok(["skipped", "error"].includes(r[id].status), id + " " + r[id].status);
  });

  await test("engine: two runs byte-identical", async () => {
    const strip = res => JSON.stringify(res.results.map(r => ({ id: r.id, status: r.status, text: r.text, outputs: r.outputs })));
    const a = await runWorkflow(SG.migrate.preset("rust", "rust"));
    const b = await runWorkflow(SG.migrate.preset("rust", "rust"));
    assert.equal(strip(a.res), strip(b.res));
  });

  for (const name of ["branch", "fix-loop", "retry"]) {
    await test("engine: preset " + name + " runs end to end, deterministic", async () => {
      const strip = res => JSON.stringify(res.results.map(r => ({ id: r.id, status: r.status, text: r.text, outputs: r.outputs, attempts: r.attempts, iterations: r.iterations })));
      const a = await runWorkflow(SG.migrate.preset(name, "rust"));
      const b = await runWorkflow(SG.migrate.preset(name, "rust"));
      assert.equal(strip(a.res), strip(b.res));
      assert.equal(a.res.status, "ok", strip(a.res));
      const r = byId(a.res);
      if (name === "branch") {
        for (const id of ["n4", "n5", "n6", "n7", "n8", "n11", "n12"]) assert.equal(r[id].status, "done", id);
        for (const id of ["n9", "n10"]) assert.equal(r[id].status, "skipped", id);
      } else if (name === "fix-loop") {
        assert.equal(r.n6.status, "done");
        assert.equal(r.n6.iterations, 2);
        assert.doesNotMatch(String(r.n6.text), /已達上限/);
      } else {
        assert.equal(r.n3.status, "done");
        assert.ok(r.n3.attempts >= 2, "attempts " + r.n3.attempts);
      }
    });
  }

  await test("engine: syncCatalog registers agent/skill/tool and agent runs nested workflow", async () => {
    const profiles = new Map([["research", { id: "research", name: "資料搜尋", tool_refs: [{ id: "file-access", operations: ["read"] }] }]]);
    SG.nodes.syncCatalog({ profiles, skills: new Map([["s1", { id: "s1", description: "技能" }]]),
      tools: new Map([["file-access", { id: "file-access", name: "檔案存取", operations: ["read", "write"] }]]) });
    for (const t of ["agent/research", "skill/s1", "tool/file-access"]) assert.ok(SG.registry.get(t), t);
    SG.nodes.loadWorkflow = id => SG.migrate.preset(SG.migrate.presetFor(id), id);
    const g = new SG.Graph({ schema: "sea-agent-studio/workflow", version: 1, nodes: [], links: [], groups: [], view: { x: 0, y: 0, k: 1 }, next: 1 });
    const s = g.addNode("skill/s1", { x: 0, y: 0 }), t = g.addNode("tool/file-access", { x: 0, y: 200, widgets: { operation: "寫入檔案" } });
    const a = g.addNode("agent/research", { x: 300, y: 0 });
    assert.ok(g.connect(s.id, "skill", a.id, "skill"));
    assert.ok(g.connect(t.id, "tool", a.id, "tool"));
    const issues = SG.nodes.permissionIssues(g, profiles);
    assert.equal(issues.length, 1); assert.equal(issues[0].level, "error");
    const ex = new SG.Executor(g, { registry: SG.registry, delay: fast });
    const res = await ex.queue({ targets: g.nodes.map(n => n.id) });
    const ra = res.results.find(r => r.id === a.id);
    assert.equal(ra.status, "done", ra.text);
    assert.match(ra.outputs.artifact.text, /子流程完成 3\/3/);
    SG.nodes.loadWorkflow = null;
  });
}

(async () => {
  await pure();
  if (!engineMissing) await engine();
  else console.log("SKIP: engine not merged yet");
  console.log("\n" + passed + " passed, " + failures.length + " failed");
  process.exit(failures.length ? 1 : 0);
})();
