# Plan: ComfyUI-style node graph for 小海 Agent 工作室 (adviser: Fable 5.2) — FROZEN CONTRACT

## Summary
Replace the `#editor` flow canvas (single in/out, naive `run()`) with a real node-graph system in classic scripts under `comfy/`, all on one global `SeaGraph`. `#assembly` stays untouched.
- Rendering: DOM nodes + SVG wires inside a CSS-transformed world layer (not Canvas2D) so ports stay real `<button>`s, widgets real inputs; click-to-connect, aria labels, keyboard survive.
- IIFE mandatory: every file is `(function(root){ const SG = root.SeaGraph = root.SeaGraph || {}; ... })(globalThis);` with NO top-level `const`/`let`/`class`. The inline script already owns global lexical names (`$`, `graph`, `key`, `selected`, `parts`) — a clash is a SyntaxError.
- Must run by double-clicking the HTML (file://): no build step, no ES modules, no CDN, no network, no dependencies.
- Storage: new key `sea-agent-studio-v06.flow.<agentId>`. Old `sea-agent-studio-v02.<id>` is read for migration, never written.
- Execution is simulated/offline and deterministic (no Math.random/Date in outputs), but async + AbortSignal so a real backend can plug in later.
- UI text zh-Hant-TW. Preserve a11y (click-to-connect alternative, aria labels, keyboard).

## Files per workstream (disjoint)
**A — Engine (DOM-free, Node-loadable)**: `comfy/graph.js` (types, registry, Graph model, validation, history, clipboard, serialisation), `comfy/executor.js` (queue, cache, events, abort), `comfy/core-nodes.js` (`core/primitive-*`, `core/reroute`, `core/note`, `core/preview`), `tests/engine.test.js`.

**B — Canvas**: `comfy/canvas.js`, `comfy/minimap.js`, `comfy/search.js`, `comfy/canvas.css`, `comfy/dev/canvas-demo.html`, `comfy/dev/mock-engine.js` (contract-shaped stub, never loaded by app).

**C — Library & integration (SOLE editor of the HTML)**: `Agent-Studio-v0.5.html` (rewrite `#editor` markup, remove old flow render/connect/run code located by function name, add link/script tags), `comfy/nodes.js` (DOM-free), `comfy/migrate.js` (DOM-free), `comfy/app.js`, `comfy/app.css`, `tests/nodes.test.js`.

Load order: `graph.js, executor.js, core-nodes.js, nodes.js, migrate.js, canvas.js, minimap.js, search.js` before the inline scripts; `app.js` after them (it reads `profiles`, `skills`, `toolsCatalog`, `showPanel`, `completed`).

## Interface contract
```js
// Workflow JSON (persisted and exported)
{ schema:"sea-agent-studio/workflow", version:1, agent:"rust",
  nodes:[{ id:"n1", type:"search/query", x:20, y:24, w:220, h:0,   // h 0 = auto
           title:null, mode:"normal"|"bypass"|"mute", collapsed:false,
           widgets:{query:"Rust 測試"},     // by NAME, not position
           converted:["query"],            // widgets exposed as input slots
           props:{agentRef:"rust"} }],
  links:[{ id:"l1", from:"n1", out:"query", to:"n2", in:"query" }], // slot NAMES
  groups:[{ id:"g1", title:"搜尋", x:0,y:0,w:640,h:200, color:"#3b82f6" }],
  view:{x:0,y:0,k:1}, next:3 }
```
```js
// A: types
SG.types.define(id, {label, color, accepts?:string[]});   // "*" = wildcard
SG.types.compatible(outType, inType) -> boolean
SG.types.get(id) -> {id,label,color}

// A: registry
SG.registry.register({
  type:"search/query", title:"查詢", category:"搜尋", hint:"…",
  inputs:[{name,type,label,optional?:bool}],
  outputs:[{name,type,label}],
  widgets:[{name,kind:"text"|"number"|"select"|"toggle"|"textarea",label,
            default,options?,min?,max?,step?,maxLength?,convertible?:bool,type?}],
  output?:bool,      // terminal node; execution targets
  virtual?:bool,     // reroute/note: never executed, resolved by engine
  estimate?(values) -> {tokens:number, ms:number, writes:boolean},
  async execute(inputs, ctx) -> {[outputName]: value}
});
SG.registry.get(type) | .list() | .search(text) | .unregister(type)
// ctx: {signal:AbortSignal, node, widgets, progress(0..1,text?), log(text), seed:string}
// preview convention: any output value may carry {text:string, sources?:[], producedBy?:nodeId}

// A: graph (emits "change", {reason,ids})
const g = new SG.Graph(json?);
g.toJSON(); g.load(json); g.on(evt,fn) -> off()
g.addNode(type,{x,y,widgets?,props?}) -> node;  g.removeNodes(ids)
g.moveNodes(ids,dx,dy); g.setWidget(id,name,value); g.setMode(id,mode)
g.convertWidget(id,name,toInput:boolean)
g.canConnect(from,out,to,inp) -> {ok:boolean, reason?:string}   // zh-Hant text
g.connect(from,out,to,inp) -> link|null     // replaces existing input link
g.disconnect(linkId); g.linksOf(id); g.getNode(id)
g.slots(id) -> {inputs:[…], outputs:[…]}    // includes converted widgets
g.addGroup(rect); g.updateGroup(id,patch); g.removeGroup(id)
g.validate() -> [{level:"error"|"warn", nodeId, slot?, message}]
g.order(targetIds?) -> string[]             // topological; throws SG.CycleError
g.copy(ids) -> clip;  g.paste(clip,{x,y}) -> newIds
g.history: {commit(label), undo(), redo(), canUndo, canRedo}  // cap 100
g.batch(fn)                                 // one change event, one history entry
// also: g.nodes (array), g.links (array), g.groups (array), g.view ({x,y,k}); g.setView(view) (no history entry)

// A: executor
const ex = new SG.Executor(g, {registry:SG.registry, delay:ms=>Promise});
ex.queue({targets?:string[], dryRun?:boolean}) -> Promise<RunResult>
ex.cancel(); ex.clearCache(ids?); ex.isDirty(id); ex.output(id) -> outputs|undefined
ex.estimate() -> {tokens,ms,writes,perNode:{}}
ex.on(evt,fn):
 "queue"{pending} "run-start"{runId,order} "node-start"{id} "node-progress"{id,value,text}
 "node-done"{id,outputs,cached:boolean,ms} "node-error"{id,message}
 "node-skip"{id,reason:"mute"|"upstream"|"blocked"} "run-end"{runId,status:"ok"|"error"|"cancelled",results}
// RunResult = {runId,status,results:[{id,status:"done"|"cached"|"error"|"skipped",text,outputs}]}
// Cache key = hash(type, widgets, mode, upstream keys). Bypass = same-typed inputs pass to outputs.

// B: canvas
const c = SG.Canvas.mount(hostEl, {graph, registry:SG.registry, types:SG.types,
  onSelect(ids), onStatus(text), onOpenNode(id), onRequestRun(),
  onDropType(type,x,y)?, readOnly?:bool, labels?:{}});
c.setNodeState(id,{status:"idle"|"queued"|"running"|"done"|"cached"|"error"|"skipped",
                   progress?, preview?:string, message?})
c.clearStates(); c.fit(); c.zoomTo(k); c.centerOn(id); c.select(ids); c.selection()
c.toWorld(clientX,clientY) -> {x,y}; c.openSearch(x?,y?); c.focus(); c.destroy()
// Palette drag MIME stays "application/x-sea-node" (value = node type).
// B never calls the executor; C bridges ex.on(...) -> c.setNodeState(...).
// B re-renders on graph "change" events; B commits history once on drag end, never per pointermove.

// C
SG.migrate.fromV05(oldGraph) -> workflowJSON   // pure
SG.nodes.registerAll(SG); SG.nodes.syncCatalog({profiles,skills,tools})
```
Migration map: old edge `[a,b]` → link from a's first output to b's first input; `value` → node's single widget; `agentRef` → `props.agentRef`. Kinds map to `search/query|read|cite` and `code/<lang>-read|build|test`. Type ids `QUERY, SOURCES, SUMMARY, PROJECT_<LANG>, BUILD_<LANG>, REPORT` keep the existing Chinese labels. `*-read.summary` stays optional.

## Feature list
**A MUST**: multi-slot typed model, `canConnect` reasons, cycle rejection, `validate()`; widget→input conversion; topological execution with dirty-only caching; sequential queue; bypass & mute; virtual reroute resolution; primitive nodes; AbortSignal cancellation; deterministic outputs (seed = node id + widgets); history, copy/paste, JSON round-trip, tolerant `load()` (unknown types kept as "missing" placeholders, invalid links dropped with warning, never throw).
**A NICE**: `dryRun` + `estimate()`; group-scoped run (`targets`).

**B MUST**: pan (space/middle-drag, arrow keys) + zoom (wheel, +/-), fit; multi-slot ports and wires coloured by type; ghost wire; drag-to-connect and click-output-then-click-input with `aria-pressed`, Esc cancels; inline widgets of all five kinds; convert widget via node context menu; multi-select (Shift-click) + box select; move selection; shortcuts Delete, Ctrl+C/V/Z/Y, Ctrl+A, Ctrl+Enter (run), Ctrl+B (bypass), Ctrl+M (mute) — ignored when target is input/textarea/select; status ring, progress bar, inline preview per node; double-click search popup (filterable listbox, arrows, Enter); keyboard node nudging; `role="group"` + `aria-label` per node; live status via `onStatus`. rAF-batched wire redraw; fine to ~300 nodes.
**B NICE**: minimap; group frames (drag moves contents, Ctrl+G); reroute by double-clicking a wire; collapse node; snap-to-grid; drop-wire-on-empty opens type-filtered search.

**C MUST**: domain nodes reproducing every `simulate()` behaviour and error text; migration with fallback to presets; presets rebuilt as workflows; debounced persistence on `change`; `completed` and home status preserved; library drawer generated from registry; reuse-agent insertion; inspector drawer (accessible fallback for all widgets, links list, remove); run panel with queue, cancel, per-node results, plus existing preflight; export/import JSON; drag-drop `.json` onto canvas; zh-Hant-TW; keep `parts` as capability catalogue for profile checkboxes.
**C NICE**: import old `schema_version:1` exports; shortcut help dialog.

## Improvements beyond ComfyUI (Fable 5.2)
1. Agent/Skill/Tool as live node types (now): `syncCatalog` registers `agent/<id>`, `skill/<id>`, `tool/<id>` from real catalogues.
2. Subgraph = Agent (now, depth ≤ 3): `agent/<id>` node runs that agent's saved workflow in a nested executor.
3. Typed artifacts with provenance (now): outputs carry `{text, sources, producedBy}`.
4. Dry-run estimate (now): tokens, time and「會寫入」shown before queueing.
5. Permission-aware wiring (now, light): tool nodes show read/write badges; `validate()` errors when a write op reaches an agent granted read only (reuse `configurationCheck`).
6. Human approval gate node (later). 7. Control flow branch/retry/loop (later). 8. Run history diff & replay (later).

## Acceptance tests
1. `node tests/engine.test.js`: incompatible types & cycles rejected with reason; second `queue()` all `cached`; after `setWidget` on a middle node only it + downstream re-run; bypass passes through, mute skips downstream; `cancel()` → `cancelled`; undo/redo round-trip and `new Graph(g.toJSON())` round-trip; widget conversion adds an input slot.
2. `node tests/nodes.test.js`: `fromV05(base("rust"))` → 6 nodes / 5 links, runs 6/6; empty query → 「查詢詞不能留白」; unmatched keyword blocks downstream; two runs byte-identical.
3. `grep -nE "^(const|let|class|import|export) " comfy/*.js` empty.
4. `grep -rnE "fetch\(|XMLHttpRequest" comfy/*.js` empty.
5. Manual: v0.5 saved flow migrates; keyboard-only connect; search popup adds node; run highlights in order, rerun shows 快取; export→clear→drag-drop restores; Ctrl+Z; assembly page unaffected; clean console.
6. `comfy/dev/canvas-demo.html` works standalone against the mock.

## Merge order & risks
Merge A → B → C; C last, run all tests. Contract changes go through the lead only. Slot names are link keys. Only `g.batch`/`history.commit` create undo entries. Locate HTML code by function name, not line number.

## Amendment 1 — approval gate + run history (now in scope)
```js
// A (engine)
// registry def may set nocache:true (never cached, always re-executed).
// ctx.requestApproval({message, details?}) -> Promise<boolean>; resolves on ex.approve; rejects (AbortError) on cancel.
ex.approve(nodeId, approved:boolean, note?:string)
ex.pending() -> [{id, message, details}]
// new event "node-wait" {id, message, details}; dryRun never waits.
// core/approval node: input "value" "*", output "value" "*" (effective type = upstream type, like reroute),
//   widgets: message (textarea, default "請確認是否繼續"), auto (toggle, default false = auto-approve).
//   nocache:true. Rejected -> node-error "已拒絕" + (note ? "：" + note : "") -> downstream skip "upstream".
// RunResult adds: order:string[], snapshot:<workflow JSON at run start>, results[i].key (cache key), results[i].ms.
// B (canvas)
// setNodeState status adds "waiting" (amber pulse); state may carry approval:{message}
//   -> node renders inline 核准 / 拒絕 buttons calling opts.onApprove(id, approved).
// C (app) — new DOM-free file comfy/runs.js, loaded after migrate.js:
SG.runs.record(runResult, {agent, at:ISOString}) -> entry {id, agent, at, status, snapshot, order, results}
SG.runs.diff(entryA, entryB) -> [{id, title, change:"added"|"removed"|"changed"|"same",
                                   statusBefore, statusAfter, textBefore, textAfter, widgetsChanged:[names]}]
// App: localStorage "sea-agent-studio-v06.runs.<agentId>", cap 20 newest.
// 「執行紀錄」drawer: list runs; pick two -> diff view; 「重播」 replays stored states onto canvas step by step
// (no execution); 「還原此版本」 loads snapshot into graph (confirm, one history entry).
// Run panel lists pending approvals with 核准/拒絕 + note input; also bridges canvas onApprove -> ex.approve.
```
Tests: engine.test covers approve / reject / cancel-while-waiting / auto; nodes.test covers runs.record + runs.diff.
