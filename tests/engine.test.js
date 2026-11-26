/* Engine tests for SeaGraph (workstream A). Run: node tests/engine.test.js */
"use strict";
const assert = require("node:assert");
require("../comfy/graph.js");
require("../comfy/executor.js");
require("../comfy/core-nodes.js");
const SG = globalThis.SeaGraph;

// ---------------------------------------------------------------- harness
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const tick = () => new Promise((r) => setImmediate(r));
async function until(cond, label) {
  for (let i = 0; i < 500; i++) { if (cond()) return; await tick(); }
  throw new Error("timeout waiting for " + label);
}

// ------------------------------------------------------------ test nodes
SG.types.define("TEXT", { label: "文本", color: "#0ea5e9", accepts: ["STRING"] });
SG.types.define("IMAGE", { label: "圖片", color: "#ec4899" });
const calls = {};
function count(type) { calls[type] = (calls[type] || 0) + 1; }
function resetCalls() { Object.keys(calls).forEach((k) => delete calls[k]); }

SG.registry.register({
  type: "t/src", title: "來源", category: "測試", hint: "產生文本",
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  widgets: [{ name: "value", kind: "text", label: "值", default: "hi" }],
  estimate: () => ({ tokens: 10, ms: 100, writes: false }),
  async execute(inputs, ctx) { count("t/src"); return { text: { text: String(ctx.widgets.value), seed: ctx.seed, producedBy: ctx.node.id } }; }
});
SG.registry.register({
  type: "t/upper", title: "轉大寫", category: "測試",
  inputs: [{ name: "text", type: "TEXT", label: "文本" }],
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  widgets: [{ name: "suffix", kind: "text", label: "後綴", default: "!" }, { name: "times", kind: "number", label: "次數", default: 1 }],
  estimate: () => ({ tokens: 20, ms: 200, writes: true }),
  async execute(inputs, ctx) { count("t/upper"); return { text: { text: inputs.text.text.toUpperCase() + String(ctx.widgets.suffix).repeat(Number(ctx.widgets.times) || 1) } }; }
});
SG.registry.register({
  type: "t/sink", title: "輸出", category: "測試", output: true,
  inputs: [{ name: "text", type: "TEXT", label: "文本" }, { name: "extra", type: "TEXT", label: "附加", optional: true }],
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  async execute(inputs) { count("t/sink"); return { text: { text: "結果:" + inputs.text.text + (inputs.extra ? "+" + inputs.extra.text : "") } }; }
});
SG.registry.register({
  type: "t/image", title: "圖片來源", category: "測試",
  outputs: [{ name: "img", type: "IMAGE", label: "圖片" }],
  async execute() { return { img: { text: "[img]" } }; }
});
SG.registry.register({
  type: "t/fail", title: "會失敗", category: "測試",
  inputs: [{ name: "text", type: "TEXT", label: "文本" }],
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  async execute() { throw new Error("故意失敗"); }
});
SG.registry.register({
  type: "t/slow", title: "很慢", category: "測試",
  inputs: [{ name: "text", type: "TEXT", label: "文本" }],
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  async execute(inputs, ctx) {
    count("t/slow");
    ctx.progress(0.5, "一半");
    await new Promise(() => {}); // never resolves; cancel must still end the run
  }
});

function chain() {
  const g = new SG.Graph();
  const a = g.addNode("t/src", { x: 0, y: 0 });
  const b = g.addNode("t/upper", { x: 240, y: 0 });
  const c = g.addNode("t/sink", { x: 480, y: 0 });
  assert.ok(g.connect(a.id, "text", b.id, "text"));
  assert.ok(g.connect(b.id, "text", c.id, "text"));
  return { g, a, b, c };
}
function collect(ex) {
  const ev = [];
  ["queue", "run-start", "node-start", "node-progress", "node-done", "node-error", "node-skip", "node-wait", "run-end"].forEach((n) => ex.on(n, (p) => ev.push([n, p])));
  return ev;
}
const byId = (r) => Object.fromEntries(r.results.map((x) => [x.id, x]));

// ------------------------------------------------------------------ tests
test("types: wildcard, accepts, labels", () => {
  assert.ok(SG.types.compatible("*", "IMAGE"));
  assert.ok(SG.types.compatible("IMAGE", "*"));
  assert.ok(SG.types.compatible("STRING", "TEXT"), "TEXT accepts STRING");
  assert.ok(!SG.types.compatible("TEXT", "STRING"));
  assert.ok(!SG.types.compatible("IMAGE", "TEXT"));
  assert.strictEqual(SG.types.get("TEXT").label, "文本");
});

test("registry: get/list/search/unregister", () => {
  assert.ok(SG.registry.get("t/src"));
  assert.ok(SG.registry.list().some((d) => d.type === "core/reroute"));
  assert.deepStrictEqual(SG.registry.search("轉大").map((d) => d.type), ["t/upper"]);
  assert.ok(SG.registry.search("T/SRC").some((d) => d.type === "t/src"), "case-insensitive type match");
  assert.ok(SG.registry.search("測試").length >= 5, "category match");
  assert.ok(SG.registry.search("產生文本").some((d) => d.type === "t/src"), "hint match");
  SG.registry.register({ type: "t/tmp", title: "暫時" });
  assert.ok(SG.registry.unregister("t/tmp"));
  assert.strictEqual(SG.registry.get("t/tmp"), undefined);
});

test("addNode fills widget defaults and ids share next", () => {
  const g = new SG.Graph();
  const a = g.addNode("t/upper", { x: 1, y: 2, widgets: { times: 3 } });
  assert.strictEqual(a.id, "n1");
  assert.deepStrictEqual(a.widgets, { suffix: "!", times: 3 });
  const grp = g.addGroup({ x: 0, y: 0, w: 100, h: 100, title: "組" });
  assert.strictEqual(grp.id, "g2");
  const b = g.addNode("t/src", {});
  const l = g.connect(b.id, "text", a.id, "text");
  assert.strictEqual(l.id, "l4");
  assert.strictEqual(g.addNode("nope/unknown", {}), null);
});

test("canConnect: incompatible types, cycles, self-link, unknown slot", () => {
  const { g, a, b, c } = chain();
  const img = g.addNode("t/image", {});
  let r = g.canConnect(img.id, "img", b.id, "text");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "類型不相容：「圖片」不能接「文本」。");
  assert.strictEqual(g.connect(img.id, "img", b.id, "text"), null);
  // cycle: c -> b would loop b -> c -> b
  const u2 = g.addNode("t/upper", {});
  g.connect(c.id, "text", u2.id, "text");
  r = g.canConnect(u2.id, "text", b.id, "text");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "不能循環連線，請改選其他輸入。");
  assert.strictEqual(g.canConnect(b.id, "text", b.id, "text").ok, false);
  assert.match(g.canConnect(b.id, "text", b.id, "text").reason, /自己/);
  assert.match(g.canConnect(a.id, "nope", b.id, "text").reason, /找不到輸出埠/);
  assert.match(g.canConnect(a.id, "text", b.id, "nope").reason, /找不到輸入埠/);
});

test("connect replaces existing input link; outputs multi-link", () => {
  const { g, a, b } = chain();
  const a2 = g.addNode("t/src", {});
  g.connect(a2.id, "text", b.id, "text");
  const into = g.links.filter((l) => l.to === b.id && l.in === "text");
  assert.strictEqual(into.length, 1);
  assert.strictEqual(into[0].from, a2.id);
  const b2 = g.addNode("t/upper", {});
  g.connect(a2.id, "text", b2.id, "text");
  assert.strictEqual(g.links.filter((l) => l.from === a2.id).length, 2);
  assert.strictEqual(g.linksOf(a.id).length, 0);
});

test("widget conversion adds input slot; converted input overrides widget at run", async () => {
  const { g, b, c } = chain();
  assert.strictEqual(g.slots(b.id).inputs.length, 1);
  assert.ok(g.convertWidget(b.id, "times", true));
  const ins = g.slots(b.id).inputs;
  assert.strictEqual(ins.length, 2);
  assert.deepStrictEqual([ins[1].name, ins[1].type, ins[1].widget], ["times", "NUMBER", true]);
  // unlinked converted input is a validate() error
  assert.ok(g.validate().some((i) => i.level === "error" && i.nodeId === b.id && i.slot === "times"));
  const num = g.addNode("core/primitive-number", { widgets: { value: 3 } });
  assert.ok(g.connect(num.id, "value", b.id, "times"));
  const ex = new SG.Executor(g);
  const r = await ex.queue();
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(byId(r)[c.id].text, "結果:HI!!!");
  // converting back removes the link
  assert.ok(g.convertWidget(b.id, "times", false));
  assert.strictEqual(g.links.filter((l) => l.to === b.id && l.in === "times").length, 0);
  assert.strictEqual(g.slots(b.id).inputs.length, 1);
});

test("second queue() is all cached; setWidget middle re-runs only it + downstream", async () => {
  resetCalls();
  const { g, a, b, c } = chain();
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const r1 = await ex.queue();
  assert.strictEqual(r1.status, "ok");
  assert.deepStrictEqual(r1.order, [a.id, b.id, c.id]);
  assert.deepStrictEqual(r1.results.map((x) => x.status), ["done", "done", "done"]);
  assert.strictEqual(byId(r1)[c.id].text, "結果:HI!");
  assert.ok(r1.results.every((x) => typeof x.key === "string" && typeof x.ms === "number"));
  assert.strictEqual(r1.snapshot.nodes.length, 3);
  const r2 = await ex.queue();
  assert.deepStrictEqual(r2.results.map((x) => x.status), ["cached", "cached", "cached"]);
  assert.ok(ev.filter(([n, p]) => n === "node-done" && p.cached).length === 3);
  assert.deepStrictEqual(r2.results.map((x) => x.key), r1.results.map((x) => x.key));
  assert.strictEqual(calls["t/src"], 1);
  g.setWidget(b.id, "suffix", "?");
  assert.ok(!ex.isDirty(a.id) && ex.isDirty(b.id) && ex.isDirty(c.id));
  const r3 = await ex.queue();
  assert.deepStrictEqual(r3.results.map((x) => x.status), ["cached", "done", "done"]);
  assert.strictEqual(byId(r3)[c.id].text, "結果:HI?");
  assert.deepStrictEqual(calls, { "t/src": 1, "t/upper": 2, "t/sink": 2 });
  assert.deepStrictEqual(ex.output(c.id), { text: { text: "結果:HI?" } });
  ex.clearCache([c.id]);
  assert.ok(ex.isDirty(c.id));
});

test("bypass passes same-typed input through", async () => {
  const { g, b, c } = chain();
  g.setMode(b.id, "bypass");
  const ex = new SG.Executor(g);
  const r = await ex.queue();
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(byId(r)[c.id].text, "結果:hi");
  assert.ok(byId(r)[b.id].bypassed);
});

test("bypass with no compatible input -> downstream blocked", async () => {
  const g = new SG.Graph();
  const n = g.addNode("core/primitive-number", {});
  SG.registry.register({
    type: "t/num2text", inputs: [{ name: "n", type: "NUMBER" }], outputs: [{ name: "text", type: "TEXT" }],
    async execute(i) { return { text: { text: String(i.n) } }; }
  });
  const m = g.addNode("t/num2text", {});
  const s = g.addNode("t/sink", {});
  g.connect(n.id, "value", m.id, "n");
  g.connect(m.id, "text", s.id, "text");
  g.setMode(m.id, "bypass");
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const r = await ex.queue();
  assert.strictEqual(byId(r)[s.id].reason, "blocked");
  assert.ok(ev.some(([e, p]) => e === "node-skip" && p.id === s.id && p.reason === "blocked" && /缺少必要輸入/.test(p.message)));
});

test("mute skips node and downstream (upstream reason)", async () => {
  const { g, a, b, c } = chain();
  g.setMode(a.id, "mute");
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const r = await ex.queue();
  const skips = ev.filter(([n]) => n === "node-skip").map(([, p]) => [p.id, p.reason]);
  assert.deepStrictEqual(skips, [[a.id, "mute"], [b.id, "upstream"], [c.id, "upstream"]]);
  assert.strictEqual(r.status, "ok");
});

test("error: node-error, downstream upstream-skip, independent branch runs", async () => {
  const g = new SG.Graph();
  const a = g.addNode("t/src", {});
  const f = g.addNode("t/fail", {});
  const s1 = g.addNode("t/sink", {});
  const s2 = g.addNode("t/sink", {});
  g.connect(a.id, "text", f.id, "text");
  g.connect(f.id, "text", s1.id, "text");
  g.connect(a.id, "text", s2.id, "text");
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const r = await ex.queue();
  assert.strictEqual(r.status, "error");
  const m = byId(r);
  assert.strictEqual(m[f.id].status, "error");
  assert.strictEqual(m[f.id].text, "故意失敗");
  assert.strictEqual(m[s1.id].reason, "upstream");
  assert.strictEqual(m[s2.id].status, "done");
  assert.ok(ev.some(([n, p]) => n === "node-error" && p.id === f.id));
});

test("missing required input -> blocked, run status error", async () => {
  const g = new SG.Graph();
  const s = g.addNode("t/sink", {});
  const ex = new SG.Executor(g);
  const r = await ex.queue();
  assert.strictEqual(byId(r)[s.id].reason, "blocked");
  assert.strictEqual(byId(r)[s.id].text, "缺少必要輸入「文本」。");
  assert.strictEqual(r.status, "error");
});

test("cancel() -> cancelled; queued jobs dropped", async () => {
  resetCalls();
  const g = new SG.Graph();
  const a = g.addNode("t/src", {});
  const sl = g.addNode("t/slow", {});
  const s = g.addNode("t/sink", {});
  g.connect(a.id, "text", sl.id, "text");
  g.connect(sl.id, "text", s.id, "text");
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const p1 = ex.queue();
  const p2 = ex.queue();
  assert.deepStrictEqual(ev.filter(([n]) => n === "queue").map(([, p]) => p.pending), [1, 2]);
  await until(() => calls["t/slow"] === 1, "slow node start");
  assert.ok(ev.some(([n, p]) => n === "node-progress" && p.id === sl.id && p.value === 0.5));
  ex.cancel();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(r1.status, "cancelled");
  assert.strictEqual(r2.status, "cancelled");
  assert.strictEqual(byId(r1)[a.id].status, "done");
  assert.strictEqual(byId(r1)[s.id].status, "skipped");
  assert.ok(ev.some(([n, p]) => n === "run-end" && p.status === "cancelled"));
  assert.ok(!ex.running);
});

test("queue is sequential", async () => {
  const { g } = chain();
  const ex = new SG.Executor(g, { delay: () => tick() });
  const seq = [];
  ex.on("run-start", (p) => seq.push("start:" + p.runId));
  ex.on("run-end", (p) => seq.push("end:" + p.runId));
  const [r1, r2] = await Promise.all([ex.queue(), ex.queue()]);
  assert.deepStrictEqual(seq, ["start:r1", "end:r1", "start:r2", "end:r2"]);
  assert.strictEqual(r2.results.every((x) => x.status === "cached"), true);
  assert.strictEqual(r1.runId, "r1");
});

test("reroute resolution: chain of reroutes, effective type, execution", async () => {
  const g = new SG.Graph();
  const a = g.addNode("t/src", {});
  const r1 = g.addNode("core/reroute", {});
  const r2 = g.addNode("core/reroute", {});
  const s = g.addNode("t/sink", {});
  const img = g.addNode("t/image", {});
  assert.strictEqual(g.slots(r1.id).outputs[0].type, "*");
  assert.ok(g.connect(r1.id, "out", r2.id, "in"));
  assert.ok(g.connect(r2.id, "out", s.id, "text"));
  // reroute chain already feeds a TEXT input: IMAGE upstream is rejected
  assert.match(g.canConnect(img.id, "img", r1.id, "in").reason, /類型不相容：「圖片」不能接「文本」/);
  assert.ok(g.connect(a.id, "text", r1.id, "in"));
  assert.strictEqual(g.slots(r2.id).outputs[0].type, "TEXT");
  assert.deepStrictEqual(g.inputSource(s.id, "text"), { node: a.id, out: "text", link: g.inputLink(r1.id, "in") });
  const u = g.addNode("t/upper", {});
  assert.ok(g.canConnect(r2.id, "out", u.id, "text").ok);
  const r3 = g.addNode("core/reroute", {});
  g.connect(img.id, "img", r3.id, "in");
  assert.strictEqual(g.canConnect(r3.id, "out", u.id, "text").ok, false);
  assert.deepStrictEqual(g.order(), [a.id, s.id], "virtual nodes omitted from order");
  const ex = new SG.Executor(g);
  const r = await ex.queue();
  assert.strictEqual(byId(r)[s.id].text, "結果:hi");
  // note node: virtual, no slots, never executed
  const note = g.addNode("core/note", { widgets: { text: "說明" } });
  assert.deepStrictEqual(g.slots(note.id), { inputs: [], outputs: [] });
  assert.ok(!g.order().includes(note.id));
});

test("primitives and preview", async () => {
  const g = new SG.Graph();
  const s = g.addNode("core/primitive-string", { widgets: { value: "你好" } });
  const b = g.addNode("core/primitive-boolean", { widgets: { value: true } });
  const p = g.addNode("core/preview", {});
  const p2 = g.addNode("core/preview", {});
  g.connect(s.id, "value", p.id, "value");
  g.connect(b.id, "value", p2.id, "value");
  assert.strictEqual(g.slots(p.id).outputs[0].type, "STRING");
  const ex = new SG.Executor(g);
  const r = await ex.queue();
  assert.strictEqual(byId(r)[p.id].text, "你好");
  assert.strictEqual(byId(r)[p2.id].text, "true");
  assert.deepStrictEqual(ex.output(p.id), { value: "你好", text: "你好" });
});

test("deterministic outputs and seed", async () => {
  const run = async () => { const { g } = chain(); const ex = new SG.Executor(g); return JSON.stringify((await ex.queue()).results.map((x) => [x.id, x.status, x.text, x.outputs, x.key])); };
  const x = await run(), y = await run();
  assert.strictEqual(x, y);
  const g = chain().g;
  const ex = new SG.Executor(g);
  await ex.queue();
  assert.strictEqual(ex.output("n1").text.seed, SG.hash("n1" + SG.stableStringify({ value: "hi" })));
});

test("undo/redo round-trip and JSON round-trip", () => {
  const { g, a, b } = chain();
  const changes = [];
  g.on("change", (e) => changes.push(e.reason));
  const before = JSON.stringify(g.toJSON());
  g.setWidget(b.id, "suffix", "~");
  g.moveNodes([a.id], 10, 5);
  g.moveNodes([a.id], 10, 5); // coalesced with previous move
  g.history.commit("拖曳");
  g.moveNodes([a.id], 1, 1);
  const after = JSON.stringify(g.toJSON());
  assert.ok(g.history.canUndo);
  assert.ok(g.history.undo()); // last move
  assert.deepStrictEqual([g.getNode(a.id).x, g.getNode(a.id).y], [20, 10]);
  assert.ok(g.history.undo()); // coalesced move
  assert.deepStrictEqual([g.getNode(a.id).x, g.getNode(a.id).y], [0, 0]);
  assert.ok(g.history.undo()); // widget
  assert.strictEqual(JSON.stringify(g.toJSON()), before);
  assert.ok(g.history.canRedo);
  g.history.redo(); g.history.redo(); g.history.redo();
  assert.strictEqual(JSON.stringify(g.toJSON()), after);
  assert.ok(!g.history.canRedo);
  assert.ok(changes.includes("undo") && changes.includes("redo"));
  // setView: change {reason:"view"} but no history entry
  const n = changes.length, size = g.history.size;
  let viewEv = 0;
  g.on("view", () => viewEv++);
  g.setView({ x: 5, y: 6, k: 2 });
  assert.deepStrictEqual(changes.slice(n), ["view"]);
  assert.strictEqual(g.history.size, size);
  assert.strictEqual(viewEv, 1);
  // JSON round trip
  g.convertWidget(b.id, "times", true);
  g.addGroup({ title: "群組A", x: 0, y: 0, w: 300, h: 200 });
  g.updateNode(a.id, { title: "改名", collapsed: true, props: { agentRef: "rust" } });
  const j = g.toJSON();
  assert.strictEqual(j.schema, "sea-agent-studio/workflow");
  assert.deepStrictEqual(j.view, { x: 5, y: 6, k: 2 });
  const g2 = new SG.Graph(j);
  assert.deepStrictEqual(g2.toJSON(), j);
  assert.deepStrictEqual(g2.warnings, []);
  assert.deepStrictEqual(new SG.Graph(JSON.stringify(j)).toJSON(), j);
});

test("history: direct mutation + commit, cap 100", () => {
  const g = new SG.Graph();
  const a = g.addNode("t/src", {});
  a.x = 50; // canvas-style direct mutation during drag
  assert.ok(g.history.commit("移動"));
  assert.ok(!g.history.commit("無變更"));
  g.history.undo();
  assert.strictEqual(g.getNode(a.id).x, 0);
  g.history.redo();
  assert.strictEqual(g.getNode(a.id).x, 50);
  for (let i = 0; i < 150; i++) g.setWidget(a.id, "value", "v" + i);
  assert.strictEqual(g.history.size, 100);
  let undos = 0;
  while (g.history.undo()) undos++;
  assert.strictEqual(undos, 100);
  assert.strictEqual(g.getNode(a.id).widgets.value, "v49");
});

test("batch: one change event, one history entry", () => {
  const g = new SG.Graph();
  const events = [];
  g.on("change", (e) => events.push(e));
  const size0 = g.history.size;
  let ids;
  g.batch(() => {
    const a = g.addNode("t/src", {});
    const b = g.addNode("t/upper", {});
    g.connect(a.id, "text", b.id, "text");
    g.moveNodes([a.id, b.id], 5, 5);
    ids = [a.id, b.id];
  });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].reason, "batch");
  assert.deepStrictEqual(events[0].ids.sort(), ids.sort());
  assert.strictEqual(g.history.size, size0 + 1);
  g.history.undo();
  assert.strictEqual(g.nodes.length, 0);
  assert.strictEqual(g.links.length, 0);
});

test("copy/paste remaps ids and internal links", () => {
  const { g, a, b, c } = chain();
  g.setWidget(b.id, "suffix", "#");
  const clip = g.copy([a.id, b.id]);
  assert.strictEqual(clip.nodes.length, 2);
  assert.strictEqual(clip.links.length, 1, "only internal links copied");
  const newIds = g.paste(clip, { x: 100, y: 300 });
  assert.strictEqual(newIds.length, 2);
  assert.ok(newIds.every((id) => ![a.id, b.id, c.id].includes(id)));
  const na = g.getNode(newIds[0]), nb = g.getNode(newIds[1]);
  assert.deepStrictEqual([na.x, na.y], [100, 300]);
  assert.strictEqual(nb.widgets.suffix, "#");
  assert.ok(g.links.some((l) => l.from === na.id && l.to === nb.id));
  assert.strictEqual(g.links.length, 3);
  g.history.undo();
  assert.strictEqual(g.nodes.length, 3);
  // paste via JSON string, default offset
  const ids2 = g.paste(JSON.stringify(g.copy([a.id])));
  assert.deepStrictEqual([g.getNode(ids2[0]).x, g.getNode(ids2[0]).y], [24, 24]);
});

test("tolerant load: missing types kept, invalid links dropped with warnings", async () => {
  const json = {
    schema: "sea-agent-studio/workflow", version: 1, agent: "rust",
    nodes: [
      { id: "n1", type: "t/src", x: 0, y: 0, widgets: { value: "x" } },
      { id: "n2", type: "plugin/ghost", x: 200, y: 0, widgets: { foo: 1 }, converted: ["foo"], props: { a: 1 } },
      { id: "n3", type: "t/sink", x: 400, y: 0 },
      { id: "n3", type: "t/sink" },
      { nope: true }
    ],
    links: [
      { id: "l4", from: "n1", out: "text", to: "n2", in: "src" },
      { id: "l5", from: "n2", out: "result", to: "n3", in: "text" },
      { id: "l6", from: "n1", out: "text", to: "n9", in: "text" },
      { id: "l7", from: "n1", out: "bogus", to: "n3", in: "extra" },
      { id: "l8", from: "n1", out: "text", to: "n3", in: "text" }
    ],
    groups: [], view: { x: 0, y: 0, k: 1 }, next: 9
  };
  let g;
  assert.doesNotThrow(() => { g = new SG.Graph(json); });
  assert.strictEqual(g.nodes.length, 3);
  const ghost = g.getNode("n2");
  assert.strictEqual(ghost.missing, true);
  assert.deepStrictEqual(g.slots("n2").inputs.map((s) => s.name), ["src"]);
  assert.deepStrictEqual(g.slots("n2").outputs.map((s) => s.name), ["result"]);
  assert.deepStrictEqual(g.links.map((l) => l.id), ["l4", "l5"]);
  assert.ok(g.warnings.length >= 5, "warnings: " + JSON.stringify(g.warnings));
  assert.ok(g.warnings.some((w) => /plugin\/ghost/.test(w)));
  assert.ok(g.warnings.some((w) => /l6/.test(w)) && g.warnings.some((w) => /l7/.test(w)) && g.warnings.some((w) => /l8/.test(w)));
  // round trip keeps the missing node and its links
  const out = g.toJSON();
  const back = new SG.Graph(out).toJSON();
  assert.deepStrictEqual(back, out);
  assert.deepStrictEqual(out.nodes[1], { id: "n2", type: "plugin/ghost", x: 200, y: 0, w: 220, h: 0, title: null, mode: "normal", collapsed: false, widgets: { foo: 1 }, converted: ["foo"], props: { a: 1 }, retry: { max: 0, delay: 0 } });
  assert.strictEqual(out.agent, "rust");
  // validate reports the missing type; execution errors on it and skips downstream
  assert.ok(g.validate().some((i) => i.level === "error" && i.nodeId === "n2" && /plugin\/ghost/.test(i.message)));
  const r = await new SG.Executor(g).queue();
  assert.strictEqual(byId(r).n2.status, "error");
  assert.strictEqual(byId(r).n3.reason, "upstream");
  // garbage never throws
  assert.doesNotThrow(() => new SG.Graph("not json{"));
  assert.doesNotThrow(() => new SG.Graph({ nodes: "x", links: [null, 3] }));
  const g3 = new SG.Graph();
  let ev = 0;
  g3.on("change", (e) => { if (e.reason === "load") ev++; });
  g3.load(json);
  assert.strictEqual(ev, 1);
  assert.strictEqual(g3.history.canUndo, false);
  assert.strictEqual(g3.next, 9);
});

test("cycles: order() throws CycleError, validate reports", () => {
  const g = new SG.Graph({
    nodes: [{ id: "n1", type: "t/upper" }, { id: "n2", type: "t/upper" }, { id: "n3", type: "t/sink" }],
    links: [{ id: "l1", from: "n1", out: "text", to: "n2", in: "text" }, { id: "l2", from: "n2", out: "text", to: "n1", in: "text" }, { id: "l3", from: "n2", out: "text", to: "n3", in: "text" }]
  });
  assert.throws(() => g.order(), (e) => e instanceof SG.CycleError && e.ids.sort().join() === "n1,n2");
  const v = g.validate();
  assert.ok(v.some((i) => i.nodeId === "n1" && /循環/.test(i.message)));
  assert.ok(!v.some((i) => i.nodeId === "n3" && /循環/.test(i.message)));
});

test("validate: missing inputs and nodes without path to an output", () => {
  const { g, b } = chain();
  const orphan = g.addNode("t/upper", {});
  const v = g.validate();
  assert.ok(v.some((i) => i.level === "error" && i.nodeId === orphan.id && i.slot === "text" && i.message === "缺少必要輸入「文本」。"));
  assert.ok(v.some((i) => i.level === "warn" && i.nodeId === orphan.id));
  assert.ok(!v.some((i) => i.nodeId === b.id));
  g.setMode(orphan.id, "mute");
  assert.ok(!g.validate().some((i) => i.level === "error" && i.nodeId === orphan.id));
});

test("targets (group-scoped run), order, dryRun and estimate", async () => {
  resetCalls();
  const { g, a, b, c } = chain();
  const side = g.addNode("t/sink", { x: 0, y: 500 });
  g.connect(a.id, "text", side.id, "text");
  const grp = g.addGroup({ x: -10, y: 400, w: 400, h: 300 });
  assert.deepStrictEqual(g.nodesInGroup(grp.id), [side.id]);
  assert.deepStrictEqual(g.order([side.id]), [a.id, side.id]);
  const ex = new SG.Executor(g);
  const est = ex.estimate();
  assert.deepStrictEqual([est.tokens, est.ms, est.writes], [30, 300, true]);
  assert.strictEqual(est.perNode[b.id].tokens, 20);
  const dry = await ex.queue({ dryRun: true });
  assert.strictEqual(dry.dryRun, true);
  assert.ok(dry.results.every((x) => x.status === "skipped" && x.text === "試跑：未執行"));
  assert.strictEqual(Object.keys(calls).length, 0, "dryRun never executes");
  const r = await ex.queue({ targets: g.nodesInGroup(grp.id) });
  assert.deepStrictEqual(r.order, [a.id, side.id]);
  assert.strictEqual(calls["t/upper"], undefined);
  const est2 = ex.estimate();
  assert.strictEqual(est2.perNode[a.id].cached, true);
  assert.deepStrictEqual([est2.tokens, est2.full.tokens], [20, 30]);
  void c;
});

// ------------------------------------------------------- approval gates
function approvalGraph(widgets) {
  const g = new SG.Graph();
  const a = g.addNode("t/src", {});
  const ap = g.addNode("core/approval", { widgets });
  const s = g.addNode("t/sink", {});
  g.connect(a.id, "text", ap.id, "value");
  g.connect(ap.id, "value", s.id, "text");
  return { g, a, ap, s };
}

test("approval: effective type follows upstream; approve passes value", async () => {
  const { g, ap, s } = approvalGraph();
  assert.strictEqual(g.slots(ap.id).outputs[0].type, "TEXT");
  const img = g.addNode("t/image", {});
  assert.strictEqual(g.canConnect(img.id, "img", ap.id, "value").ok, false, "downstream TEXT consumer rejects IMAGE");
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const p = ex.queue();
  await until(() => ex.pending().length === 1, "approval wait");
  assert.deepStrictEqual(ex.pending()[0].id, ap.id);
  assert.strictEqual(ex.pending()[0].message, "請確認是否繼續");
  assert.ok(ev.some(([n, x]) => n === "node-wait" && x.id === ap.id && x.message === "請確認是否繼續"));
  assert.strictEqual(ex.approve("n999", true), false);
  assert.ok(ex.approve(ap.id, true));
  const r = await p;
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(byId(r)[s.id].text, "結果:hi");
  assert.strictEqual(ex.pending().length, 0);
  // nocache: approval re-runs and waits again; downstream stays cached when value unchanged
  assert.ok(ex.isDirty(ap.id));
  const p2 = ex.queue();
  await until(() => ex.pending().length === 1, "second approval wait");
  ex.approve(ap.id, true);
  const r2 = await p2;
  assert.deepStrictEqual(r2.results.map((x) => x.status), ["cached", "done", "cached"]);
});

test("approval: reject with note -> node-error, downstream upstream-skip", async () => {
  const { g, ap, s } = approvalGraph({ message: "要發布嗎？" });
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const p = ex.queue();
  await until(() => ex.pending().length === 1, "approval wait");
  assert.strictEqual(ex.pending()[0].message, "要發布嗎？");
  ex.approve(ap.id, false, "內容有誤");
  const r = await p;
  assert.strictEqual(r.status, "error");
  assert.ok(ev.some(([n, x]) => n === "node-error" && x.id === ap.id && x.message === "已拒絕：內容有誤"));
  assert.strictEqual(byId(r)[s.id].reason, "upstream");
  // reject without note
  const p2 = ex.queue();
  await until(() => ex.pending().length === 1, "approval wait 2");
  ex.approve(ap.id, false);
  assert.strictEqual(byId(await p2)[ap.id].text, "已拒絕");
});

test("approval: cancel while waiting -> cancelled", async () => {
  const { g } = approvalGraph();
  const ex = new SG.Executor(g);
  const p = ex.queue();
  await until(() => ex.pending().length === 1, "approval wait");
  ex.cancel();
  const r = await p;
  assert.strictEqual(r.status, "cancelled");
  assert.strictEqual(ex.pending().length, 0);
});

test("approval: auto approves without waiting; dryRun never waits", async () => {
  const { g, s } = approvalGraph({ auto: true });
  const ex = new SG.Executor(g);
  const ev = collect(ex);
  const r = await ex.queue();
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(byId(r)[s.id].text, "結果:hi");
  assert.ok(!ev.some(([n]) => n === "node-wait"));
  const g2 = approvalGraph().g;
  const dry = await new SG.Executor(g2).queue({ dryRun: true });
  assert.strictEqual(dry.status, "ok");
});

// ------------------------------------------------- lead requests (canvas)
test("nested batch joins outermost: one change, one history entry", () => {
  const g = new SG.Graph();
  const events = [];
  g.on("change", (e) => events.push(e.reason));
  const size0 = g.history.size;
  const ret = g.batch(() => {
    const a = g.addNode("t/src", {});
    const inner = g.batch(() => { g.addNode("t/sink", {}); g.batch(() => g.moveNodes([a.id], 3, 3)); return 7; });
    assert.strictEqual(inner, 7);
    assert.strictEqual(events.length, 0, "no event before outermost batch ends");
    return "x";
  });
  assert.strictEqual(ret, "x");
  assert.deepStrictEqual(events, ["batch"]);
  assert.strictEqual(g.history.size, size0 + 1);
  g.history.undo();
  assert.strictEqual(g.nodes.length, 0);
});

test("load(json, {history:true}) is one undoable entry; plain load resets history", () => {
  const g = new SG.Graph();
  g.addNode("t/src", {});
  const before = JSON.stringify(g.toJSON().nodes);
  const other = new SG.Graph(); other.addNode("t/src", {}); other.addNode("t/src", {});
  let reasons = [];
  g.on("change", e => reasons.push(e.reason));
  g.load(other.toJSON(), { history: true, label: "還原" });
  assert.strictEqual(g.nodes.length, 2);
  assert.deepStrictEqual(reasons, ["load"]);
  assert.ok(g.history.canUndo === true || (typeof g.history.canUndo === "function" && g.history.canUndo()));
  g.history.undo();
  assert.strictEqual(JSON.stringify(g.toJSON().nodes), before);
  g.history.redo();
  assert.strictEqual(g.nodes.length, 2);
  g.load(other.toJSON());
  assert.ok(!(g.history.canUndo === true || (typeof g.history.canUndo === "function" && g.history.canUndo())));
});

test("setTitle / setCollapsed are undoable; addNode/paste/addGroup/list shapes", () => {
  const g = new SG.Graph();
  const a = g.addNode("t/src", {});
  assert.strictEqual(typeof a, "object");
  assert.strictEqual(a.id, "n1");
  assert.ok(g.setTitle(a.id, "我的來源"));
  assert.ok(g.setCollapsed(a.id, true));
  assert.deepStrictEqual([g.getNode(a.id).title, g.getNode(a.id).collapsed], ["我的來源", true]);
  g.history.undo();
  assert.strictEqual(g.getNode(a.id).collapsed, false);
  assert.strictEqual(g.getNode(a.id).title, "我的來源");
  g.history.undo();
  assert.strictEqual(g.getNode(a.id).title, null);
  g.history.redo(); g.history.redo();
  assert.deepStrictEqual([g.getNode(a.id).title, g.getNode(a.id).collapsed], ["我的來源", true]);
  assert.ok(g.setTitle(a.id, null));
  assert.strictEqual(g.getNode(a.id).title, null);
  const grp = g.addGroup({ x: 1, y: 2, w: 3, h: 4 });
  assert.deepStrictEqual(Object.keys(grp).sort(), ["color", "h", "id", "title", "w", "x", "y"]);
  const ids = g.paste(g.copy([a.id]));
  assert.ok(Array.isArray(ids) && ids.length === 1 && typeof ids[0] === "string");
  assert.ok(SG.registry.list().every((d) => typeof d.type === "string" && Array.isArray(d.inputs)));
  const lg = new SG.Graph({ nodes: [{ id: "n1", type: "x/unknown" }] });
  assert.strictEqual(lg.getNode("n1").missing, true);
});

// ------------------------------------------------------- control flow
SG.registry.register({
  type: "t/append", title: "加號", category: "測試",
  inputs: [{ name: "text", type: "TEXT", label: "文本" }],
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  estimate: () => ({ tokens: 5, ms: 10, writes: false }),
  async execute(inputs, ctx) {
    count("t/append");
    (calls.iters = calls.iters || []).push(ctx.iteration ? ctx.iteration.index + "/" + ctx.iteration.max : "-");
    return { text: { text: inputs.text.text + "+" } };
  }
});
SG.registry.register({
  type: "t/flaky", title: "不穩定", category: "測試",
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  widgets: [{ name: "fails", kind: "number", label: "失敗次數", default: 0 }],
  async execute(inputs, ctx) {
    count("t/flaky");
    if (ctx.attempt < Number(ctx.widgets.fails)) throw new Error("暫時失敗 " + ctx.attempt);
    return { text: { text: "ok@" + ctx.attempt } };
  }
});
SG.registry.register({
  type: "t/aborter", title: "自行中止", category: "測試",
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  async execute() { count("t/aborter"); const e = new Error("被中止"); e.name = "AbortError"; throw e; }
});
SG.registry.register({
  type: "t/hang", title: "卡住", category: "測試",
  outputs: [{ name: "text", type: "TEXT", label: "文本" }],
  async execute() { count("t/hang"); await new Promise(() => {}); }
});

test("condition modes (no eval) incl. invalid regex", async () => {
  const ev = SG.control.evalCondition;
  assert.strictEqual(ev({ text: " " }, { mode: "nonempty" }), false);
  assert.strictEqual(ev({ text: "a" }, { mode: "nonempty" }), true);
  assert.strictEqual(ev({ text: "Rust 測試" }, { mode: "contains", pattern: "Rust" }), true);
  assert.strictEqual(ev("Go", { mode: "contains", pattern: "Rust" }), false);
  assert.strictEqual(ev("abc", { mode: "equals", pattern: "abc" }), true);
  assert.strictEqual(ev(12, { mode: "equals", pattern: "12" }), true);
  assert.strictEqual(ev({ text: "v1.2" }, { mode: "regex", pattern: "^v\\d+\\.\\d+$" }), true);
  assert.strictEqual(ev(true, { mode: "truthy" }), true);
  assert.strictEqual(ev("false", { mode: "truthy" }), false);
  assert.strictEqual(ev(0, { mode: "truthy" }), false);
  assert.strictEqual(ev("x", { mode: "nonempty", negate: true }), false);
  assert.throws(() => ev("x", { mode: "regex", pattern: "(" }), /規則格式錯誤/);
  // node-level: invalid regex -> node-error, not retried
  const g = new SG.Graph();
  const s = g.addNode("t/src", {});
  const c = g.addNode("core/condition", { widgets: { mode: "regex", pattern: "([" } });
  const p = g.addNode("core/preview", {});
  g.connect(s.id, "text", c.id, "value");
  g.connect(c.id, "result", p.id, "value");
  g.setRetry(c.id, { max: 3 });
  const ex = new SG.Executor(g);
  const evs = collect(ex);
  ex.on("node-retry", (x) => evs.push(["node-retry", x]));
  const r = await ex.queue();
  assert.strictEqual(r.status, "error");
  assert.match(byId(r)[c.id].text, /規則格式錯誤/);
  assert.strictEqual(byId(r)[p.id].reason, "upstream");
  assert.ok(!evs.some(([n]) => n === "node-retry"));
  // valid condition -> BOOLEAN preview
  g.setWidget(c.id, "pattern", "^h");
  const r2 = await ex.queue();
  assert.strictEqual(byId(r2)[p.id].text, "true");
  assert.strictEqual(g.slots(p.id).outputs[0].type, "BOOLEAN");
});

function branchGraph(text) {
  const g = new SG.Graph();
  const s = g.addNode("t/src", { widgets: { value: text } });
  const br = g.addNode("core/branch", { widgets: { mode: "contains", pattern: "Rust" } });
  const up = g.addNode("t/upper", {});
  const ap = g.addNode("t/append", {});
  const after = g.addNode("t/upper", {}); // downstream of the false path
  const mg = g.addNode("core/merge", {});
  const out = g.addNode("t/sink", {});
  const side = g.addNode("t/sink", {});
  g.connect(s.id, "text", br.id, "value");
  assert.ok(g.connect(br.id, "true", up.id, "text"));
  assert.ok(g.connect(br.id, "false", ap.id, "text"));
  g.connect(ap.id, "text", after.id, "text");
  g.connect(after.id, "text", side.id, "text");
  assert.ok(g.connect(up.id, "text", mg.id, "a"));
  assert.ok(g.connect(ap.id, "text", mg.id, "b"));
  assert.ok(g.connect(mg.id, "value", out.id, "text"));
  return { g, s, br, up, ap, after, mg, out, side };
}

test("branch: inactive side skips with reason branch (propagates); merge picks active", async () => {
  const t = branchGraph("Rust 測試");
  assert.strictEqual(t.g.slots(t.br.id).outputs[1].type, "TEXT");
  assert.strictEqual(t.g.slots(t.mg.id).outputs[0].type, "TEXT");
  const ex = new SG.Executor(t.g);
  const ev = collect(ex);
  const r = await ex.queue();
  const m = byId(r);
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(m[t.up.id].status, "done");
  assert.deepStrictEqual([m[t.ap.id].reason, m[t.after.id].reason, m[t.side.id].reason], ["branch", "branch", "branch"]);
  assert.strictEqual(m[t.out.id].text, "結果:RUST 測試!");
  assert.ok(ev.some(([n, p]) => n === "node-skip" && p.id === t.ap.id && p.reason === "branch"));
  // flip the condition
  t.g.setWidget(t.s.id, "value", "Go 測試");
  const r2 = await ex.queue();
  const m2 = byId(r2);
  assert.strictEqual(r2.status, "ok");
  assert.strictEqual(m2[t.up.id].reason, "branch");
  assert.strictEqual(m2[t.out.id].text, "結果:Go 測試+");
  assert.strictEqual(m2[t.side.id].text, "結果:GO 測試+!");
  // merge with every input inactive -> branch skip downstream
  const g = new SG.Graph();
  const s = g.addNode("t/src", { widgets: { value: "x" } });
  const br = g.addNode("core/branch", { widgets: { mode: "contains", pattern: "zzz" } });
  const mg = g.addNode("core/merge", {});
  const out = g.addNode("t/sink", {});
  g.connect(s.id, "text", br.id, "value");
  g.connect(br.id, "true", mg.id, "a");
  g.connect(mg.id, "value", out.id, "text");
  const r3 = await new SG.Executor(g).queue();
  assert.strictEqual(r3.status, "ok");
  assert.deepStrictEqual([byId(r3)[mg.id].reason, byId(r3)[out.id].reason], ["branch", "branch"]);
  // linked condition input overrides own widgets
  const cond = g.addNode("core/condition", { widgets: { mode: "equals", pattern: "hi" } });
  const s2 = g.addNode("t/src", {});
  g.connect(s2.id, "text", cond.id, "value");
  g.connect(cond.id, "result", br.id, "condition");
  const r4 = await new SG.Executor(g).queue();
  assert.strictEqual(byId(r4)[out.id].text, "結果:x");
});

function loopGraph(max, pattern) {
  const g = new SG.Graph();
  const s = g.addNode("t/src", {});
  const ls = g.addNode("core/loop-start", { widgets: { max } });
  const ap = g.addNode("t/append", {});
  const le = g.addNode("core/loop-end", { widgets: { mode: "contains", pattern } });
  const out = g.addNode("t/sink", {});
  g.connect(s.id, "text", ls.id, "init");
  assert.ok(g.connect(ls.id, "value", ap.id, "text"), "loop value follows init type");
  assert.ok(g.connect(ls.id, "loop", le.id, "loop"));
  assert.ok(g.connect(ap.id, "text", le.id, "value"));
  assert.ok(g.connect(le.id, "result", out.id, "text"));
  return { g, s, ls, ap, le, out };
}

test("loop runs until done; loop-end cached on rerun", async () => {
  resetCalls();
  const t = loopGraph(5, "+++");
  const info = t.g.loops();
  assert.strictEqual(info.loops.length, 1);
  assert.deepStrictEqual(Array.from(info.loops[0].body), [t.ap.id]);
  const ex = new SG.Executor(t.g);
  const ev = collect(ex);
  const iters = [];
  ex.on("loop-iteration", (p) => iters.push([p.id, p.startId, p.index, p.max]));
  const est = ex.estimate();
  assert.strictEqual(est.perNode[t.ap.id].tokens, 25, "body estimate scaled by max");
  const r = await ex.queue();
  assert.strictEqual(r.status, "ok");
  assert.deepStrictEqual(iters, [[t.le.id, t.ls.id, 0, 5], [t.le.id, t.ls.id, 1, 5], [t.le.id, t.ls.id, 2, 5]]);
  assert.deepStrictEqual(calls.iters, ["0/5", "1/5", "2/5"]);
  const m = byId(r);
  assert.strictEqual(m[t.le.id].iterations, 3);
  assert.strictEqual(m[t.le.id].text, "hi+++");
  assert.deepStrictEqual(ex.output(t.le.id), { result: { text: "hi+++" }, count: 3 });
  assert.strictEqual(m[t.out.id].text, "結果:hi+++");
  assert.strictEqual(m[t.ap.id].attempts, 1);
  assert.ok(ev.filter(([n, p]) => n === "node-done" && p.id === t.ap.id).length === 3);
  // rerun: whole loop cached, body not re-executed
  const r2 = await ex.queue();
  assert.ok(r2.results.every((x) => x.status === "cached"), JSON.stringify(r2.results.map((x) => x.status)));
  assert.strictEqual(calls["t/append"], 3);
  assert.strictEqual(byId(r2)[t.le.id].iterations, 3);
  assert.ok(!ex.isDirty(t.ap.id));
  t.g.setWidget(t.ls.id, "max", 4);
  assert.ok(ex.isDirty(t.ap.id) && ex.isDirty(t.le.id));
});

test("loop stops at max with 已達上限 text (not an error)", async () => {
  const t = loopGraph(3, "+++++");
  const r = await new SG.Executor(t.g).queue();
  assert.strictEqual(r.status, "ok");
  const le = byId(r)[t.le.id];
  assert.strictEqual(le.iterations, 3);
  assert.strictEqual(le.maxed, true);
  assert.match(le.text, /已達上限 3 輪/);
  assert.strictEqual(byId(r)[t.out.id].text, "結果:hi+++");
  // done input linked: condition in the body decides
  const t2 = loopGraph(9, "never");
  const cond = t2.g.addNode("core/condition", { widgets: { mode: "contains", pattern: "++" } });
  t2.g.connect(t2.ap.id, "text", cond.id, "value");
  assert.ok(t2.g.connect(cond.id, "result", t2.le.id, "done"));
  const r2 = await new SG.Executor(t2.g).queue();
  assert.strictEqual(byId(r2)[t2.le.id].iterations, 2);
});

test("nested loops iterate inner fully per outer iteration", async () => {
  resetCalls();
  const g = new SG.Graph();
  const s = g.addNode("t/src", {});
  const o1 = g.addNode("core/loop-start", { widgets: { max: 2 } });
  const i1 = g.addNode("core/loop-start", { widgets: { max: 3 } });
  const ap = g.addNode("t/append", {});
  const i2 = g.addNode("core/loop-end", { widgets: { mode: "contains", pattern: "zzz" } });
  const o2 = g.addNode("core/loop-end", { widgets: { mode: "contains", pattern: "zzz" } });
  const out = g.addNode("t/sink", {});
  g.connect(s.id, "text", o1.id, "init");
  g.connect(o1.id, "loop", o2.id, "loop");
  g.connect(o1.id, "value", i1.id, "init");
  g.connect(i1.id, "loop", i2.id, "loop");
  g.connect(i1.id, "value", ap.id, "text");
  g.connect(ap.id, "text", i2.id, "value");
  g.connect(i2.id, "result", o2.id, "value");
  g.connect(o2.id, "result", out.id, "text");
  const info = g.loops();
  const inner = info.loops.find((L) => L.endId === i2.id);
  assert.strictEqual(inner.depth, 2);
  assert.strictEqual(inner.parent.endId, o2.id);
  assert.ok(!g.validate().some((i) => i.level === "error"));
  const r = await new SG.Executor(g).queue();
  assert.strictEqual(r.status, "ok");
  assert.strictEqual(calls["t/append"], 6);
  assert.deepStrictEqual(calls.iters, ["0/3", "1/3", "2/3", "0/3", "1/3", "2/3"]);
  assert.strictEqual(byId(r)[o2.id].iterations, 2);
  assert.strictEqual(byId(r)[i2.id].iterations, 3);
  assert.strictEqual(byId(r)[out.id].text, "結果:hi++++++");
});

test("crossing loop regions -> validate error 迴圈區段交錯, run errors", async () => {
  const g = new SG.Graph();
  const s = g.addNode("t/src", {});
  const a1 = g.addNode("core/loop-start", {});
  const a2 = g.addNode("core/loop-start", {});
  const mid = g.addNode("t/sink", {}); // text + optional extra
  const e1 = g.addNode("core/loop-end", {});
  const e2 = g.addNode("core/loop-end", {});
  g.connect(s.id, "text", a1.id, "init");
  g.connect(s.id, "text", a2.id, "init");
  g.connect(a1.id, "loop", e1.id, "loop");
  g.connect(a2.id, "loop", e2.id, "loop");
  g.connect(a1.id, "value", mid.id, "text");
  g.connect(a2.id, "value", mid.id, "extra");
  g.connect(mid.id, "text", e1.id, "value");
  g.connect(mid.id, "text", e2.id, "value");
  g.connect(e1.id, "result", g.addNode("core/preview", {}).id, "value");
  g.connect(e2.id, "result", g.addNode("core/preview", {}).id, "value");
  const errs = g.validate().filter((i) => i.level === "error");
  assert.ok(errs.some((i) => /迴圈區段交錯/.test(i.message) && i.nodeId === e1.id));
  assert.ok(errs.some((i) => /迴圈區段交錯/.test(i.message) && i.nodeId === e2.id));
  const r = await new SG.Executor(g).queue();
  assert.strictEqual(r.status, "error");
  assert.match(byId(r)[e1.id].text, /迴圈區段交錯/);
});

test("retry: success after N, exhaustion, history entry", async () => {
  resetCalls();
  const g = new SG.Graph();
  const f = g.addNode("t/flaky", { widgets: { fails: 2 } });
  const out = g.addNode("t/sink", {});
  g.connect(f.id, "text", out.id, "text");
  const size = g.history.size;
  assert.ok(g.setRetry(f.id, { max: 3, delay: 7 }));
  assert.strictEqual(g.history.size, size + 1);
  assert.deepStrictEqual(g.toJSON().nodes[0].retry, { max: 3, delay: 7 });
  assert.ok(!g.setRetry(f.id, { max: 3, delay: 7 }));
  assert.deepStrictEqual(g.getNode(f.id).retry, { max: 3, delay: 7 });
  g.setRetry(out.id, { max: 99 });
  assert.strictEqual(g.getNode(out.id).retry.max, 5, "clamped to 5");
  const delays = [];
  const ex = new SG.Executor(g, { delay: (ms) => { delays.push(ms); return Promise.resolve(); } });
  const retries = [];
  ex.on("node-retry", (p) => retries.push([p.id, p.attempt, p.max, p.message]));
  const r = await ex.queue();
  assert.strictEqual(r.status, "ok");
  assert.deepStrictEqual(retries, [[f.id, 1, 3, "暫時失敗 0"], [f.id, 2, 3, "暫時失敗 1"]]);
  assert.strictEqual(byId(r)[f.id].attempts, 3);
  assert.strictEqual(byId(r)[f.id].text, "ok@2");
  assert.ok(delays.filter((d) => d === 7).length === 2);
  // exhaustion
  g.setWidget(f.id, "fails", 5);
  retries.length = 0;
  const r2 = await ex.queue();
  assert.strictEqual(r2.status, "error");
  assert.strictEqual(retries.length, 3);
  assert.strictEqual(byId(r2)[f.id].attempts, 4);
  assert.strictEqual(byId(r2)[f.id].text, "暫時失敗 3");
  assert.strictEqual(byId(r2)[out.id].reason, "upstream");
  g.history.undo(); g.history.undo(); g.history.undo();
  assert.deepStrictEqual(g.getNode(f.id).retry, { max: 0, delay: 0 });
});

test("retry: AbortError, cancel and approval rejection are never retried", async () => {
  resetCalls();
  const g = new SG.Graph();
  const a = g.addNode("t/aborter", {});
  g.setRetry(a.id, { max: 3 });
  const ex = new SG.Executor(g);
  const retries = [];
  ex.on("node-retry", (p) => retries.push(p));
  const r = await ex.queue();
  assert.strictEqual(r.status, "error");
  assert.strictEqual(calls["t/aborter"], 1);
  assert.strictEqual(byId(r)[a.id].attempts, 1);
  // cancel while running a retry-enabled node
  const g2 = new SG.Graph();
  const h = g2.addNode("t/hang", {});
  g2.setRetry(h.id, { max: 3 });
  const ex2 = new SG.Executor(g2);
  ex2.on("node-retry", (p) => retries.push(p));
  const p2 = ex2.queue();
  await until(() => calls["t/hang"] === 1, "hang start");
  ex2.cancel();
  assert.strictEqual((await p2).status, "cancelled");
  assert.strictEqual(calls["t/hang"], 1);
  // approval rejection
  const t = approvalGraph();
  t.g.setRetry(t.ap.id, { max: 3 });
  const ex3 = new SG.Executor(t.g);
  ex3.on("node-retry", (p) => retries.push(p));
  const p3 = ex3.queue();
  await until(() => ex3.pending().length === 1, "approval");
  ex3.approve(t.ap.id, false, "不要");
  const r3 = await p3;
  assert.strictEqual(byId(r3)[t.ap.id].text, "已拒絕：不要");
  assert.strictEqual(ex3.pending().length, 0);
  assert.strictEqual(retries.length, 0);
});

// ------------------------------------------------------------------- run
(async () => {
  let passed = 0;
  const failed = [];
  for (const t of tests) {
    try { await t.fn(); passed++; }
    catch (e) { failed.push(t.name); console.error("FAIL: " + t.name + "\n  " + (e && e.stack || e)); }
  }
  console.log("engine tests: " + passed + " passed" + (failed.length ? ", " + failed.length + " failed" : ""));
  process.exit(failed.length ? 1 : 0);
})();
