/* 小海 Agent 工作室 — ComfyUI-style flow editor integration (DOM).
 * Loaded after the inline scripts; talks to them only through window.SeaStudio. */
(function (root) {
  "use strict";
  const SG = root.SeaGraph = root.SeaGraph || {};
  const doc = root.document;
  const S = root.SeaStudio;
  const $ = id => doc.getElementById(id);

  const FLOW_KEY = "sea-agent-studio-v06.flow.";
  const RUNS_KEY = "sea-agent-studio-v06.runs.";
  const LEGACY_KEY = "sea-agent-studio-v02.";
  const LEGACY_RUST = ["sea-agent-canvas-v01", "sea-agent-studio-v01"];
  const MIME = "application/x-sea-node";
  const STEP_MS = 250;
  const MAX_NODES = 300;
  const CONTROL_TYPES = ["core/approval", "core/condition", "core/branch", "core/merge", "core/loop-start", "core/loop-end"];
  const CATEGORY_ORDER = ["流程控制", "搜尋", "Rust", "Go", "Java", "Agents", "Skills", "Tools"];
  const STATUS_LABEL = { done: "示範", cached: "快取", error: "阻擋", skipped: "略過", waiting: "等待核准", running: "執行中", queued: "排隊", idle: "未執行" };
  const RUN_LABEL = { ok: "完成", error: "需要調整", cancelled: "已取消" };

  const App = SG.App = SG.App || {};
  App.ready = false;

  const st = {
    gen: 0, agent: null, graph: null, ex: null, canvas: null, offs: [],
    selection: [], saveTimer: 0, structKey: "", running: 0,
    states: new Map(), skips: new Map(), replayTimers: [], picked: [], runsMem: new Map(), muteInspector: false
  };

  // ---- small helpers ---------------------------------------------------------
  const make = (tag, text, cls) => S.make(tag, text, cls);
  const action = (text, on, cls) => S.action(text, on, cls);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const clone = v => JSON.parse(JSON.stringify(v));
  function def(type) { try { return SG.registry.get(type) || null; } catch (e) { return null; } }
  function titleOf(n) { if (!n) return "未知節點"; const d = def(n.type); return n.title || (d && d.title) || n.type; }
  function nodeById(id) { return st.graph && (st.graph.getNode ? st.graph.getNode(id) : st.graph.nodes.find(n => n.id === id)); }
  function storageGet(k) { try { return root.localStorage.getItem(k); } catch (e) { S.setStorageOk(false); return null; } }
  function storageSet(k, v) { try { root.localStorage.setItem(k, v); return true; } catch (e) { S.setStorageOk(false); return false; } }
  function on(target, evt, fn) { const off = target.on(evt, fn); if (typeof off === "function") st.offs.push(off); }
  function previewText(outputs) {
    for (const v of Object.values(outputs || {})) if (v && typeof v === "object" && typeof v.text === "string") return v.text.length > 140 ? v.text.slice(0, 139) + "…" : v.text;
    return "";
  }
  function sourcesOf(outputs) {
    for (const v of Object.values(outputs || {})) if (v && Array.isArray(v.sources) && v.sources.length) return v.sources;
    return [];
  }
  function linkTo(url, text) { const a = make("a", text); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; }
  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = make("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 600);
  }
  function optionPair(o) { return o && typeof o === "object" ? { value: o.value, label: o.label != null ? o.label : String(o.value) } : { value: o, label: String(o) }; }

  // ---- workflow resolution / persistence --------------------------------------
  function snapshot() {
    return Object.assign({ schema: SG.migrate.SCHEMA, version: SG.migrate.VERSION }, st.graph.toJSON(), { agent: st.agent });
  }
  /** Saved v06 -> migrated v0.5 -> legacy rust -> preset. */
  function resolveWorkflow(id) {
    if (id === st.agent && st.graph) return { json: snapshot(), source: "live" };
    if (S.changes.has(id)) return { json: clone(S.changes.get(id)), source: "v06" };
    const raw = storageGet(FLOW_KEY + id);
    if (raw) { try { return { json: SG.migrate.importAny(raw, id), source: "v06" }; } catch (e) { /* fall through */ } }
    const legacy = [LEGACY_KEY + id].concat(id === "rust" ? LEGACY_RUST : []);
    for (const k of legacy) {
      const old = storageGet(k);
      if (!old) continue;
      const w = SG.migrate.fromV05(old, id);
      if (w && w.nodes.length) return { json: w, source: "v05" };
    }
    return { json: SG.migrate.preset(SG.migrate.presetFor(id), id), source: "preset" };
  }
  function saveNow() {
    clearTimeout(st.saveTimer); st.saveTimer = 0;
    if (!st.graph || !st.agent) return;
    const json = snapshot();
    S.changes.set(st.agent, json);
    storageSet(FLOW_KEY + st.agent, JSON.stringify(json));
  }
  function scheduleSave() { clearTimeout(st.saveTimer); st.saveTimer = setTimeout(saveNow, 400); }
  function structKey() {
    const g = st.graph;
    return JSON.stringify([g.nodes.map(n => [n.id, n.type, n.widgets, n.mode, n.converted, n.retry]), g.links.map(l => [l.from, l.out, l.to, l.in])]);
  }
  function withHistory(fn) { let out; st.graph.batch(() => { out = fn(); }); return out; }

  // ---- catalogue ---------------------------------------------------------------
  function sync() { SG.nodes.syncCatalog({ profiles: S.profiles, skills: S.skills, tools: S.toolsCatalog }); }

  // ---- open / close ------------------------------------------------------------
  App.open = function open(agentId) {
    App.close();
    sync();
    const gen = ++st.gen;
    st.agent = agentId;
    const { json, source } = resolveWorkflow(agentId);
    const g = st.graph = new SG.Graph(json);
    const ex = st.ex = new SG.Executor(g, { registry: SG.registry, delay: ms => wait(Math.max(0, Number(ms) || 0)), stepMs: STEP_MS });
    const host = $("flow-host");
    host.replaceChildren();
    st.selection = []; st.states.clear(); st.skips.clear(); st.picked = [];
    st.canvas = SG.Canvas.mount(host, {
      graph: g, registry: SG.registry, types: SG.types,
      onSelect: ids => { if (gen !== st.gen) return; st.selection = (ids || []).slice(); renderInspector(); },
      onStatus: text => { if (gen === st.gen) S.status(text); },
      onOpenNode: id => { if (gen !== st.gen) return; st.selection = [id]; renderInspector(); S.showPanel("inspector"); focusFirst($("props")); },
      onRequestRun: () => { if (gen === st.gen) runQueue(); },
      onDropType: (type, x, y) => { if (gen === st.gen) { S.showPanel(null); addNode(type, x, y); } },
      onApprove: (id, approved) => { if (gen === st.gen) approve(id, approved); },
      labels: {}
    });
    wireEvents(gen);
    st.structKey = structKey();
    $("preset").value = SG.migrate.presetFor(agentId);
    renderInspector(); renderLibrary(); renderReuse(); renderRunPanel(null); renderHistory(); updateRunButtons();
    S.status({ v06: "就緒。流程編輯會自動儲存在這個瀏覽器。", v05: "已把 v0.5 流程轉成節點圖（原資料保留不動）。", preset: "已載入流程範例，編輯後自動儲存。", live: "就緒。" }[source]);
    if (source !== "v06") requestAnimationFrame(() => { if (gen === st.gen && st.canvas) st.canvas.fit(); });
  };
  App.close = function close() {
    if (!st.graph) return;
    saveNow();
    stopReplay();
    try { if (st.running) st.ex.cancel(); } catch (e) { /* ignore */ }
    for (const off of st.offs.splice(0)) { try { off(); } catch (e) { /* ignore */ } }
    try { st.canvas && st.canvas.destroy(); } catch (e) { /* ignore */ }
    st.gen++; st.graph = null; st.ex = null; st.canvas = null; st.agent = null; st.running = 0; st.selection = [];
    updateRunButtons();
  };
  App.focusCanvas = function () { if (st.canvas) st.canvas.focus(); else $("flow-host").focus(); };
  App.graph = () => st.graph;
  App.executor = () => st.ex;
  App.canvas = () => st.canvas;

  // ---- graph + executor events -------------------------------------------------
  function setState(id, patch, replace) {
    const next = Object.assign({}, replace ? {} : st.states.get(id) || {}, patch);
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    st.states.set(id, next);
    if (st.canvas && nodeById(id)) st.canvas.setNodeState(id, next);
  }
  function loopBody(startId, endId) {
    const links = st.graph.links;
    const fwd = new Set(), back = new Set();
    const walk = (from, set, dir) => { const stack = [from]; while (stack.length) { const id = stack.pop(); for (const l of links) { const nx = dir ? (l.from === id ? l.to : null) : (l.to === id ? l.from : null); if (nx && !set.has(nx)) { set.add(nx); stack.push(nx); } } } };
    walk(startId, fwd, true); walk(endId, back, false);
    return [...fwd].filter(id => back.has(id) && id !== startId && id !== endId);
  }
  function wireEvents(gen) {
    const g = st.graph, ex = st.ex, live = () => gen === st.gen;
    on(g, "change", () => {
      if (!live()) return;
      scheduleSave();
      const k = structKey();
      if (k !== st.structKey) { st.structKey = k; S.completed.delete(st.agent); }
      st.selection = st.selection.filter(id => nodeById(id));
      if (!st.muteInspector && S.getPanel() === "inspector") renderInspector(true);
      else $("props-toggle").disabled = !st.selection.length;
    });
    on(ex, "queue", e => { if (live()) $("run-queue").textContent = e && e.pending ? "排隊中：" + e.pending + " 個執行" : ""; });
    on(ex, "run-start", e => {
      if (!live()) return;
      stopReplay();
      st.states.clear(); st.skips.clear();
      st.canvas.clearStates();
      for (const id of (e && e.order) || []) setState(id, { status: "queued" }, true);
      $("results").replaceChildren(make("p", "執行中…", "sub"));
      renderApprovals();
      S.status("執行中…");
    });
    on(ex, "node-start", e => { if (live()) setState(e.id, { status: "running", progress: 0, message: undefined }); });
    on(ex, "node-progress", e => { if (live()) setState(e.id, { status: "running", progress: e.value, message: e.text }); });
    on(ex, "node-retry", e => { if (live()) setState(e.id, { status: "running", attempt: { n: e.attempt, max: e.max }, message: e.message }); });
    on(ex, "loop-iteration", e => {
      if (!live()) return;
      for (const id of loopBody(e.startId, e.id)) setState(id, { iteration: { index: e.index, max: e.max } });
      S.status("迴圈第 " + (Number(e.index) + 1) + "/" + e.max + " 輪");
    });
    on(ex, "node-wait", e => {
      if (!live()) return;
      setState(e.id, { status: "waiting", approval: { message: e.message } });
      S.showPanel("run-panel"); renderApprovals();
      S.status("等待核准：" + titleOf(nodeById(e.id)));
    });
    on(ex, "node-done", e => { if (live()) { setState(e.id, { status: e.cached ? "cached" : "done", progress: 1, preview: previewText(e.outputs), message: undefined, approval: undefined }); renderApprovals(); } });
    on(ex, "node-error", e => { if (live()) { setState(e.id, { status: "error", message: e.message, approval: undefined }); renderApprovals(); } });
    on(ex, "node-skip", e => {
      if (!live()) return;
      st.skips.set(e.id, e.reason);
      const message = e.reason === "branch" ? "branch" : e.reason === "mute" ? "已停用（mute）" : "前一步未通過";
      setState(e.id, { status: "skipped", message, approval: undefined });
      if (e.reason === "branch" && st.canvas.setLinkState)
        for (const l of st.graph.links) if (l.to === e.id || l.from === e.id) st.canvas.setLinkState(l.id, { inactive: true });
    });
    on(ex, "run-end", e => { if (live()) finishRun(e || {}); });
  }

  // ---- running -------------------------------------------------------------------
  function updateRunButtons() { $("cancel-run").disabled = !st.running; $("run").setAttribute("aria-busy", String(Boolean(st.running))); }
  function agentIds() {
    const ids = [st.agent];
    for (const n of st.graph.nodes) {
      if (n.props && n.props.agentRef) ids.push(n.props.agentRef);
      if (typeof n.type === "string" && n.type.indexOf("agent/") === 0) ids.push(n.type.slice(6));
    }
    return [...new Set(ids)];
  }
  function collectIssues() {
    let v = [];
    try { v = st.graph.validate() || []; } catch (e) { v = [{ level: "error", message: "驗證失敗：" + e.message }]; }
    const opts = { configurationCheck: S.configurationCheck };
    const p = SG.nodes.permissionIssues(st.graph, S.profiles, opts).map(i => Object.assign({ perm: true }, i));
    const sub = SG.nodes.subflowIssues(st.graph, S.profiles, opts).map(i => Object.assign({ perm: true }, i));
    return v.concat(p, sub);
  }
  function renderIssues(issues) {
    const area = $("run-issues"); area.replaceChildren();
    if (!issues.length) return;
    const box = make("section", null, "result sga-issues");
    box.append(make("strong", "檢查結果"));
    for (const i of issues) {
      const row = make("div", null, "sga-issue " + (i.level === "error" ? "sga-error" : "sga-warn"));
      const n = i.nodeId ? nodeById(i.nodeId) : null;
      row.append(make("span", (i.level === "error" ? "錯誤" : "提醒") + (n ? " · " + titleOf(n) : "") + "：" + i.message));
      if (n) row.append(action("選取", () => showNode(n.id)));
      box.append(row);
    }
    area.append(box);
  }
  function renderRunPanel(issues) {
    S.renderPreflight(st.graph ? agentIds() : [], $("preflight"));
    renderIssues(issues || []);
    renderApprovals();
    if (!$("results").children.length) $("results").append(make("p", "尚無結果。", "sub"));
  }
  async function runQueue() {
    if (!st.graph) return;
    const gen = st.gen;
    S.showPanel("run-panel");
    const issues = collectIssues();
    renderRunPanel(issues);
    if (!st.graph.nodes.length) { $("results").replaceChildren(make("p", "尚無結果。", "sub")); S.status("畫布空白，請先加入節點。"); return; }
    if (issues.some(i => i.perm && i.level === "error")) { S.status("權限不符，未執行。請調整 Tool 的操作或 Agent 的授權。"); return; }
    const targets = st.graph.nodes.filter(n => { const d = def(n.type); return d && !d.virtual; }).map(n => n.id);
    const snap = snapshot();
    st.running++; updateRunButtons();
    try {
      const res = await st.ex.queue({ targets });
      if (gen !== st.gen || !res) return;
      recordRun(res, snap);
    } catch (e) {
      if (gen === st.gen) S.status("執行失敗：" + (e && e.message || e));
    } finally {
      if (gen === st.gen) { st.running = Math.max(0, st.running - 1); updateRunButtons(); }
    }
  }
  App.run = runQueue;
  function skipText(r) {
    const reason = st.skips.get(r.id) || r.reason;
    if (reason === "mute") return ["略過", "已停用（mute），未執行。"];
    if (reason === "branch") return ["未走此分支", "條件分支沒有選這條路徑。"];
    if (reason === "blocked" && r.text) return ["阻擋", r.text];
    if (reason === "cancelled") return ["略過", r.text || "已取消。"];
    return ["阻擋", "前一步未通過"];
  }
  function finishRun(e) {
    const results = e.results || [];
    renderResults(results);
    renderApprovals();
    $("run-queue").textContent = "";
    if (e.status === "cancelled") { S.status("已取消執行。"); return; }
    const blocked = results.some(r => r.status === "error" || (r.status === "skipped" && !["mute", "branch"].includes(st.skips.get(r.id) || r.reason)));
    S.completed.set(st.agent, blocked ? "需要調整" : results.length ? "已預覽" : "待設定");
    const ok = results.filter(r => r.status === "done" || r.status === "cached").length;
    const cached = results.filter(r => r.status === "cached").length;
    S.status("預覽 " + ok + "/" + results.length + " 個節點完成" + (cached ? "（其中 " + cached + " 個為快取）" : "") + "。真實任務未執行。");
  }
  function renderResults(results) {
    const area = $("results"); area.replaceChildren();
    if (!results.length) { area.append(make("p", "尚無結果。", "sub")); return; }
    for (const r of results) {
      const n = nodeById(r.id);
      let label = STATUS_LABEL[r.status] || r.status, text = r.text || previewText(r.outputs);
      if (r.status === "skipped") [label, text] = skipText(r);
      const row = make("div", null, "result sga-result sga-" + r.status);
      const head = make("strong", label + " · " + titleOf(n || { type: r.id }));
      row.append(head, make("div", text || ""));
      const meta = [];
      if (r.attempts > 1) meta.push("嘗試 " + r.attempts + " 次");
      if (r.iterations != null) meta.push(r.iterations + " 輪");
      if (r.status === "cached") meta.push("沿用快取");
      if (meta.length) row.append(make("div", meta.join(" · "), "sub"));
      for (const s of sourcesOf(r.outputs)) { const d = make("div"); d.append(linkTo(s.url, s.title)); row.append(d); }
      if (n) row.append(action("在畫布上顯示", () => showNode(r.id), "sga-mini"));
      area.append(row);
    }
  }
  function showNode(id) {
    if (!st.canvas) return;
    st.canvas.select([id]); st.canvas.centerOn(id); st.selection = [id]; renderInspector();
  }

  // ---- approvals -----------------------------------------------------------------
  function renderApprovals() {
    const area = $("approvals"); area.replaceChildren();
    let list = [];
    try { list = st.ex && st.ex.pending ? st.ex.pending() || [] : []; } catch (e) { list = []; }
    for (const p of list) {
      const box = make("section", null, "result sga-approval");
      box.append(make("strong", "核准關卡 · " + titleOf(nodeById(p.id))), make("p", p.message || "請確認是否繼續"));
      if (p.details != null) box.append(make("pre", typeof p.details === "string" ? p.details : JSON.stringify(p.details, null, 2), "sga-details"));
      const lab = make("label", "備註（選填）"), note = make("input");
      note.id = "sga-note-" + p.id; note.maxLength = 300; lab.htmlFor = note.id;
      const row = make("div", null, "actions");
      row.append(action("核准", () => approve(p.id, true), "primary"), action("拒絕", () => approve(p.id, false), "danger"));
      box.append(lab, note, row);
      area.append(box);
    }
  }
  function approve(id, ok) {
    if (!st.ex || !st.ex.approve) return;
    const note = $("sga-note-" + id);
    const text = note && note.value.trim();
    st.ex.approve(id, Boolean(ok), text || undefined);
    setState(id, { status: "running", approval: undefined });
    renderApprovals();
    S.status((ok ? "已核准：" : "已拒絕：") + titleOf(nodeById(id)));
  }

  // ---- dry run ---------------------------------------------------------------------
  function localEstimate() {
    const out = { tokens: 0, ms: 0, writes: false, perNode: {} };
    for (const n of st.graph.nodes) {
      const d = def(n.type);
      if (!d || !d.estimate || n.mode === "mute") continue;
      const values = {};
      for (const w of d.widgets || []) values[w.name] = w.default;
      Object.assign(values, n.widgets || {});
      const e = d.estimate(values) || {};
      out.perNode[n.id] = e;
      out.tokens += e.tokens || 0; out.ms += e.ms || 0; out.writes = out.writes || Boolean(e.writes);
    }
    return out;
  }
  function showEstimate() {
    if (!st.graph) return;
    S.showPanel("run-panel");
    renderRunPanel(collectIssues());
    let est = null;
    try { est = st.ex.estimate ? st.ex.estimate() : null; } catch (e) { est = null; }
    if (!est) est = localEstimate();
    const box = $("estimate-box"); box.replaceChildren();
    const sec = make("section", null, "result sga-estimate");
    sec.append(make("strong", "試算（不執行）"));
    sec.append(make("div", "預估 tokens：約 " + Math.round(est.tokens || 0).toLocaleString("zh-TW")));
    sec.append(make("div", "預估時間：約 " + ((est.ms || 0) / 1000).toFixed(1) + " 秒"));
    const writers = Object.entries(est.perNode || {}).filter(([, e]) => e && e.writes).map(([id]) => titleOf(nodeById(id)));
    sec.append(make("div", est.writes ? "會寫入：" + (writers.join("、") || "是") : "不會寫入檔案", est.writes ? "sga-writes" : ""));
    sec.append(make("p", "估算只依節點設定計算，實際值會因模型與資料而不同。", "sub"));
    box.append(sec);
    S.status("試算完成：約 " + Math.round(est.tokens || 0) + " tokens" + (est.writes ? "，會寫入。" : "，不會寫入。"));
  }

  // ---- library ---------------------------------------------------------------------
  function viewOrigin() {
    const r = $("flow-host").getBoundingClientRect();
    try { return st.canvas.toWorld(r.left + 60, r.top + 50); } catch (e) { return { x: 40, y: 40 }; }
  }
  function freeSpot(origin) {
    const busy = (x, y) => st.graph.nodes.some(n => Math.abs(n.x - x) < 230 && Math.abs(n.y - y) < 130);
    for (let row = 0; row < 8; row++) for (let col = 0; col < 6; col++) {
      const x = Math.round(origin.x + col * 250), y = Math.round(origin.y + row * 150);
      if (!busy(x, y)) return { x, y };
    }
    return { x: Math.round(origin.x + 20), y: Math.round(origin.y + 20) };
  }
  function addNode(type, x, y) {
    if (!st.graph || !def(type)) return null;
    if (st.graph.nodes.length >= MAX_NODES) { S.status("這個畫布最多放 " + MAX_NODES + " 個節點。"); return null; }
    const node = withHistory(() => st.graph.addNode(type, { x: Math.round(x), y: Math.round(y) }));
    if (node) { st.canvas.select([node.id]); st.selection = [node.id]; renderInspector(); S.status("已加入 " + titleOf(node)); }
    return node;
  }
  function addAtView(type) { const p = freeSpot(viewOrigin()); S.showPanel(null); addNode(type, p.x, p.y); App.focusCanvas(); }
  function categoryOf(d) { return CONTROL_TYPES.includes(d.type) ? "流程控制" : d.category || "其他"; }
  function renderLibrary() {
    const lib = $("palette"); lib.replaceChildren();
    if (!SG.registry) return;
    const q = $("palette-filter").value.trim();
    let defs;
    try { defs = q ? SG.registry.search(q) : SG.registry.list(); } catch (e) { defs = SG.registry.list(); }
    const groups = new Map();
    for (const d of defs || []) {
      if (!d || d.hidden) continue;
      const c = categoryOf(d);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(d);
    }
    const order = [...groups.keys()].sort((a, b) => {
      const ia = CATEGORY_ORDER.indexOf(a), ib = CATEGORY_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b, "zh-Hant");
    });
    if (!order.length) lib.append(make("p", "找不到符合的節點。", "sub"));
    for (const c of order) {
      lib.append(make("div", c, "group"));
      const list = groups.get(c);
      if (c === "流程控制") list.sort((a, b) => CONTROL_TYPES.indexOf(a.type) - CONTROL_TYPES.indexOf(b.type));
      for (const d of list) {
        const label = d.type === "core/approval" ? "核准關卡" : d.title || d.type;
        const b = action("＋ " + label, () => addAtView(d.type), "part");
        if (d.hint) b.append(make("small", d.hint));
        b.draggable = true; b.dataset.part = d.type;
        b.setAttribute("aria-label", "加入 " + c + " " + label);
        b.ondragstart = e => { e.dataTransfer.setData(MIME, d.type); e.dataTransfer.effectAllowed = "copy"; requestAnimationFrame(() => $("library").classList.add("drop-through")); };
        b.ondragend = () => $("library").classList.remove("drop-through");
        lib.append(b);
      }
    }
  }
  function renderReuse() {
    const host = $("reuse-agents"); host.replaceChildren();
    const available = [...S.profiles.values()];
    if (!available.length) return;
    host.append(make("p", "重用 Agent", "group"));
    const row = make("div", null, "reuse-form"), chooser = make("select");
    chooser.setAttribute("aria-label", "選擇要重用的 Agent");
    for (const a of available) { const o = make("option", a.name); o.value = a.id; chooser.append(o); }
    chooser.value = available.some(p => p.id === st.agent) ? st.agent : available[0].id;
    row.append(chooser, action("加入", () => insertAgent(chooser.value)));
    host.append(row, make("small", "加入 Agent 節點與它的能力節點，並自動接上相容的輸出入。", "sub"));
  }
  function tryConnect(a, b, inName) {
    const outs = (st.graph.slots(a.id).outputs || []);
    for (const o of outs) if (st.graph.canConnect(a.id, o.name, b.id, inName).ok) return st.graph.connect(a.id, o.name, b.id, inName);
    return null;
  }
  function insertAgent(id) {
    const agent = S.profiles.get(id);
    if (!agent || !st.graph) return;
    sync();
    const specs = (agent.capabilities || []).map(k => SG.nodes.byKind[k]).filter(s => s && def(s.type));
    const agentType = def("agent/" + id) ? "agent/" + id : null;
    const count = specs.length + (agentType ? 1 : 0);
    if (!count) { S.status("這個 Agent 沒有可加入的能力。"); return; }
    if (st.graph.nodes.length + count > MAX_NODES) { S.status("這組能力會讓節點超過 " + MAX_NODES + " 個，未加入。"); return; }
    const origin = freeSpot(viewOrigin());
    const created = withHistory(() => {
      const made = [];
      specs.forEach((s, i) => {
        const n = st.graph.addNode(s.type, { x: origin.x + (i % 4) * 260, y: origin.y + Math.floor(i / 4) * 190, props: { agentRef: id } });
        if (!n) return;
        const prev = made[made.length - 1];
        if (prev && s.input) tryConnect(prev, n, s.input.name);
        made.push(n);
      });
      if (agentType) {
        const i = made.length;
        const an = st.graph.addNode(agentType, { x: origin.x + (i % 4) * 260, y: origin.y + Math.floor(i / 4) * 190, props: { agentRef: id } });
        if (an) {
          for (const m of made.slice().reverse()) if (tryConnect(m, an, "summary")) break;
          made.push(an);
        }
      }
      return made;
    }) || [];
    S.showPanel(null);
    if (created.length) { st.canvas.select(created.map(n => n.id)); st.selection = created.map(n => n.id); }
    S.status("已從「" + agent.name + "」加入 " + created.length + " 個節點。請按需要調整接線。");
  }

  // ---- inspector -------------------------------------------------------------------
  function focusFirst(region) { const el = region.querySelector("input,select,textarea,button"); if (el) el.focus({ preventScroll: true }); }
  function widgetControl(n, w, disabled) {
    const id = "sga-w-" + w.name;
    const value = n.widgets && n.widgets[w.name] !== undefined ? n.widgets[w.name] : w.default;
    let el;
    if (w.kind === "select") {
      el = make("select");
      for (const o of (w.options || []).map(optionPair)) { const opt = make("option", o.label); opt.value = o.value; el.append(opt); }
      el.value = value != null ? String(value) : "";
    } else if (w.kind === "textarea") {
      el = make("textarea"); el.rows = 3; el.value = value != null ? String(value) : "";
    } else if (w.kind === "toggle") {
      el = make("input"); el.type = "checkbox"; el.checked = Boolean(value);
    } else {
      el = make("input");
      el.type = w.kind === "number" ? "number" : "text";
      if (w.kind === "number") { if (w.min != null) el.min = w.min; if (w.max != null) el.max = w.max; if (w.step != null) el.step = w.step; }
      el.value = value != null ? String(value) : "";
    }
    if (w.maxLength && "maxLength" in el && w.kind !== "number") el.maxLength = w.maxLength;
    el.id = id; el.disabled = disabled;
    const read = () => {
      if (w.kind === "toggle") return el.checked;
      if (w.kind === "number") { const v = Number(el.value); return Number.isFinite(v) ? v : w.default; }
      if (w.kind === "select") { const o = (w.options || []).map(optionPair).find(x => String(x.value) === el.value); return o ? o.value : el.value; }
      return el.value;
    };
    // Every Graph mutation records one undo entry, so values are applied on
    // "change" (blur / Enter / pick), not per keystroke.
    el.onchange = () => { st.muteInspector = true; try { st.graph.setWidget(n.id, w.name, read()); } finally { st.muteInspector = false; } };
    return el;
  }
  function renderInspector(keepFocus) {
    const region = $("props");
    const focused = keepFocus && doc.activeElement && region.contains(doc.activeElement) ? doc.activeElement.id : null;
    region.replaceChildren();
    const n = st.graph && st.selection.length ? nodeById(st.selection[0]) : null;
    $("props-toggle").disabled = !n;
    if (!n) { if (S.getPanel() === "inspector") S.showPanel(null); region.append(make("p", "選取節點以編輯設定。", "sub")); return; }
    const d = def(n.type), g = st.graph;
    region.append(make("h3", titleOf(n)), make("p", (d ? (d.category || "") + " · " : "") + n.type, "sub"));
    if (!d) region.append(make("p", "找不到這個節點類型（可能是已刪除的 Skill、Tool 或 Agent），執行時不會運作。", "skill-missing"));
    else if (d.hint) region.append(make("p", d.hint, "sub"));
    if (n.props && n.props.agentRef) region.append(make("p", "來源：" + ((S.profiles.get(n.props.agentRef) || {}).name || n.props.agentRef), "sub"));
    if (st.selection.length > 1) region.append(make("p", "另選取 " + (st.selection.length - 1) + " 個節點；這裡只編輯第一個。", "sub"));

    // mode
    const ml = make("label", "執行模式"), mode = make("select");
    mode.id = "sga-mode"; ml.htmlFor = mode.id;
    for (const [v, t] of [["normal", "一般"], ["bypass", "略過（bypass，輸入直接傳出）"], ["mute", "停用（mute，不執行）"]]) { const o = make("option", t); o.value = v; mode.append(o); }
    mode.value = n.mode || "normal";
    mode.onchange = () => withHistory(() => g.setMode(n.id, mode.value));
    region.append(ml, mode);

    // widgets
    for (const w of (d && d.widgets) || []) {
      const converted = (n.converted || []).includes(w.name);
      const wrap = make("div", null, "sga-widget");
      const label = make("label", (w.label || w.name) + (converted ? "（已轉為輸入）" : ""));
      const el = widgetControl(n, w, converted);
      label.htmlFor = el.id;
      if (w.kind === "toggle") { label.prepend(el); wrap.append(label); } else wrap.append(label, el);
      if (w.convertible) wrap.append(action(converted ? "改回欄位" : "轉為輸入", () => withHistory(() => g.convertWidget(n.id, w.name, !converted)), "sga-mini"));
      region.append(wrap);
    }

    // retry policy (Amendment 2)
    if (d && !d.virtual && typeof g.setRetry === "function") {
      const r = n.retry || { max: 0, delay: 0 };
      const fs = make("fieldset", null, "sga-retry");
      fs.append(make("legend", "重試設定"));
      const ml2 = make("label", "失敗時重試次數（0–5）"), max = make("input");
      max.type = "number"; max.min = 0; max.max = 5; max.step = 1; max.value = r.max || 0; max.id = "sga-retry-max"; ml2.htmlFor = max.id;
      const dl = make("label", "每次重試間隔（毫秒）"), delay = make("input");
      delay.type = "number"; delay.min = 0; delay.max = 10000; delay.step = 100; delay.value = r.delay || 0; delay.id = "sga-retry-delay"; dl.htmlFor = delay.id;
      const commit = () => {
        const m = Math.max(0, Math.min(5, Math.floor(Number(max.value) || 0)));
        const ms = Math.max(0, Math.min(10000, Math.floor(Number(delay.value) || 0)));
        withHistory(() => g.setRetry(n.id, { max: m, delay: ms }));
      };
      max.onchange = commit; delay.onchange = commit;
      fs.append(ml2, max, dl, delay);
      region.append(fs);
    }

    // nudging
    const moves = make("div", null, "moves");
    for (const [arrow, x, y, label] of [["←", -20, 0, "向左"], ["→", 20, 0, "向右"], ["↑", 0, -20, "向上"], ["↓", 0, 20, "向下"]]) {
      const b = action(arrow, () => withHistory(() => g.moveNodes([n.id], x, y)));
      b.setAttribute("aria-label", label + "移動節點"); b.id = "sga-move-" + label; moves.append(b);
    }
    region.append(moves);

    // slots and links
    let slots = { inputs: [], outputs: [] };
    try { slots = g.slots(n.id) || slots; } catch (e) { /* missing type */ }
    const typeLabel = t => { try { const x = SG.types.get(t); return x && x.label || t; } catch (e) { return t; } };
    if (slots.inputs.length) region.append(make("div", "輸入", "group"));
    for (const inp of slots.inputs) {
      const link = g.links.find(l => l.to === n.id && l.in === inp.name);
      const line = make("div", null, "edge");
      if (link) {
        line.append(make("span", (inp.label || inp.name) + " ← " + titleOf(nodeById(link.from)) + "・" + link.out),
          action("移除線", () => withHistory(() => g.disconnect(link.id))));
      } else {
        line.append(make("span", (inp.label || inp.name) + "（" + typeLabel(inp.type) + (inp.optional ? "，選填" : "") + "）：未連線"));
        const choices = [];
        for (const other of g.nodes) {
          if (other.id === n.id) continue;
          let outs = [];
          try { outs = g.slots(other.id).outputs || []; } catch (e) { outs = []; }
          for (const o of outs) if (g.canConnect(other.id, o.name, n.id, inp.name).ok) choices.push([other, o]);
        }
        if (choices.length) {
          const pick = make("select"); pick.id = "sga-link-" + inp.name;
          pick.setAttribute("aria-label", "選擇接到「" + (inp.label || inp.name) + "」的輸出");
          for (const [other, o] of choices) { const opt = make("option", titleOf(other) + "・" + (o.label || o.name)); opt.value = other.id + "\n" + o.name; pick.append(opt); }
          const go = action("連線", () => { const [from, out] = pick.value.split("\n"); withHistory(() => g.connect(from, out, n.id, inp.name)); S.status("已連線：" + titleOf(nodeById(from)) + " → " + titleOf(n)); });
          const row = make("div", null, "reuse-form"); row.append(pick, go); line.append(row);
        }
      }
      region.append(line);
    }
    const outLinks = g.links.filter(l => l.from === n.id);
    if (slots.outputs.length) region.append(make("div", "輸出", "group"));
    for (const o of slots.outputs) {
      const ls = outLinks.filter(l => l.out === o.name);
      if (!ls.length) region.append(make("div", (o.label || o.name) + "（" + typeLabel(o.type) + "）：未連線", "edge"));
      for (const l of ls) {
        const line = make("div", null, "edge");
        line.append(make("span", (o.label || o.name) + " → " + titleOf(nodeById(l.to)) + "・" + l.in), action("移除線", () => withHistory(() => g.disconnect(l.id))));
        region.append(line);
      }
    }
    region.append(action("移除節點", () => {
      withHistory(() => g.removeNodes([n.id]));
      st.selection = []; st.canvas.select([]); renderInspector();
      S.status("已從畫布移除節點。"); App.focusCanvas();
    }, "danger"));
    if (focused && $(focused)) $(focused).focus({ preventScroll: true });
  }

  // ---- run history (Amendment 1) -----------------------------------------------------
  function loadRuns() {
    if (st.runsMem.has(st.agent)) return st.runsMem.get(st.agent);
    let list = [];
    try { list = JSON.parse(storageGet(RUNS_KEY + st.agent)) || []; } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    st.runsMem.set(st.agent, list);
    return list;
  }
  function saveRuns(list) { st.runsMem.set(st.agent, list); storageSet(RUNS_KEY + st.agent, JSON.stringify(list)); }
  function recordRun(res, snap) {
    const full = Object.assign({}, res, { snapshot: res.snapshot || snap, order: res.order || (res.results || []).map(r => r.id) });
    const entry = SG.runs.record(full, { agent: st.agent, at: new Date().toISOString() });
    saveRuns(SG.runs.push(loadRuns(), entry, SG.runs.cap));
    if (S.getPanel() === "history") renderHistory();
  }
  function timeText(at) { try { return new Date(at).toLocaleString("zh-TW", { hour12: false }); } catch (e) { return String(at); } }
  function renderHistory() {
    const area = $("history-list"); area.replaceChildren();
    if (!st.agent) return;
    const list = loadRuns();
    st.picked = st.picked.filter(id => list.some(e => e.id === id));
    if (!list.length) area.append(make("p", "還沒有執行紀錄。按「▷ 執行」後會記錄在這裡。", "sub"));
    for (const e of list) {
      const c = SG.runs.counts(e);
      const row = make("div", null, "sga-run" + (st.picked.includes(e.id) ? " sga-picked" : ""));
      const lab = make("label", null, "sga-run-pick"), box = make("input");
      box.type = "checkbox"; box.checked = st.picked.includes(e.id);
      box.onchange = () => {
        st.picked = box.checked ? st.picked.concat(e.id).slice(-2) : st.picked.filter(x => x !== e.id);
        renderHistory();
      };
      lab.append(box, make("span", timeText(e.at) + " · " + (RUN_LABEL[e.status] || e.status)));
      row.append(lab, make("div", "完成 " + c.done + " · 快取 " + c.cached + " · 錯誤 " + c.error + (c.skipped ? " · 略過 " + c.skipped : ""), "sub"));
      const acts = make("div", null, "actions");
      acts.append(action("重播", () => replay(e), "sga-mini"), action("還原此版本", () => restoreRun(e), "sga-mini"));
      row.append(acts);
      area.append(row);
    }
    renderDiff(list);
  }
  const CHANGE_LABEL = { added: "新增", removed: "移除", changed: "變更", same: "相同" };
  function renderDiff(list) {
    const area = $("history-diff"); area.replaceChildren();
    if (st.picked.length !== 2) { if (list.length > 1) area.append(make("p", "勾選兩筆紀錄即可比較差異。", "sub")); return; }
    const [a, b] = st.picked.map(id => list.find(e => e.id === id)).sort((x, y) => String(x.at).localeCompare(String(y.at)));
    const rows = SG.runs.diff(a, b);
    const changed = rows.filter(r => r.change !== "same").length;
    area.append(make("h3", "比較：" + timeText(a.at) + " → " + timeText(b.at)), make("p", changed ? changed + " 個節點有差異。" : "兩次執行完全相同。", "sub"));
    const table = make("table", null, "sga-diff"), head = make("tr");
    for (const h of ["節點", "變更", "狀態", "欄位"]) { const th = make("th", h); th.scope = "col"; head.append(th); }
    const thead = make("thead"); thead.append(head);
    const tbody = make("tbody");
    for (const r of rows) {
      const tr = make("tr", null, "sga-diff-" + r.change);
      const st1 = (STATUS_LABEL[r.statusBefore] || r.statusBefore || "—") + " → " + (STATUS_LABEL[r.statusAfter] || r.statusAfter || "—");
      const cell = make("td"); cell.append(make("span", r.title));
      if (r.textBefore !== r.textAfter && (r.textBefore || r.textAfter)) cell.append(make("small", (r.textBefore || "—") + " → " + (r.textAfter || "—")));
      tr.append(cell, make("td", CHANGE_LABEL[r.change] || r.change), make("td", st1), make("td", r.widgetsChanged.join("、") || "—"));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    area.append(table);
  }
  function stopReplay() { for (const t of st.replayTimers.splice(0)) clearTimeout(t); }
  function replay(entry) {
    if (!st.canvas) return;
    if (st.running) { S.status("執行中，請等完成後再重播。"); return; }
    stopReplay();
    st.canvas.clearStates(); st.states.clear();
    const ids = (entry.order && entry.order.length ? entry.order : entry.results.map(r => r.id)).filter(id => nodeById(id));
    const byId = new Map(entry.results.map(r => [r.id, r]));
    for (const id of ids) setState(id, { status: "queued" }, true);
    ids.forEach((id, i) => {
      st.replayTimers.push(setTimeout(() => setState(id, { status: "running", progress: 0.5 }), i * STEP_MS * 2));
      st.replayTimers.push(setTimeout(() => {
        const r = byId.get(id) || {};
        setState(id, { status: r.status || "idle", progress: 1, preview: r.text || "", message: r.status === "error" || r.status === "skipped" ? r.text : undefined });
        S.status("重播 " + (i + 1) + "/" + ids.length + "（不執行）");
      }, i * STEP_MS * 2 + STEP_MS));
    });
    if (!ids.length) S.status("這筆紀錄的節點已不在畫布上。");
  }
  function restoreRun(entry) {
    if (!entry.snapshot) { S.status("這筆紀錄沒有保存流程快照。"); return; }
    if (!root.confirm("還原此版本會取代目前畫布（可用 Ctrl+Z 復原）。繼續嗎？")) return;
    replaceGraph(Object.assign(clone(entry.snapshot), { agent: st.agent }), "已還原 " + timeText(entry.at) + " 的流程版本。");
  }

  // ---- presets / import / export ---------------------------------------------------------
  /** Replace the whole workflow as ONE undo entry. */
  function loadUndoable(json, label) {
    st.graph.load(json, { history: true, label });
  }
  function replaceGraph(json, text) {
    stopReplay();
    loadUndoable(json, text);
    st.selection = []; st.canvas.clearStates(); st.canvas.select([]);
    renderInspector(); S.showPanel(null);
    requestAnimationFrame(() => st.canvas && st.canvas.fit());
    S.status(text);
    App.focusCanvas();
  }
  function sameAsPreset(json) {
    const key = w => JSON.stringify([w.nodes.map(n => [n.type, n.widgets]), w.links.map(l => [l.from, l.out, l.to, l.in])]);
    try { return key(snapshot()) === key(json); } catch (e) { return false; }
  }
  function loadPreset() {
    if (!st.graph) return;
    const name = $("preset").value, json = SG.migrate.preset(name, st.agent);
    if (st.graph.nodes.length && !sameAsPreset(json) && !root.confirm("載入範例會取代目前畫布。可先匯出 JSON。繼續嗎？")) return;
    replaceGraph(json, name === "empty" ? "已載入空白畫布。" : "已載入流程範例「" + (SG.migrate.presetTitles[name] || name) + "」。");
  }
  function exportJson() {
    if (!st.graph) return;
    download("agent-studio-" + st.agent + ".workflow.json", JSON.stringify(snapshot(), null, 2) + "\n");
    S.status("已匯出流程 JSON。");
  }
  function importText(text) {
    let json;
    try { json = SG.migrate.importAny(text, st.agent); } catch (e) { S.status("無法匯入：" + e.message); return; }
    if (st.graph.nodes.length && !root.confirm("匯入會取代目前畫布（可用 Ctrl+Z 復原）。繼續嗎？")) return;
    replaceGraph(json, "已匯入流程：" + json.nodes.length + " 個節點、" + json.links.length + " 條連線。");
  }
  async function importFile(file) {
    if (!file || !st.graph) return;
    if (file.size > 2000000) { S.status("無法匯入：檔案超過 2 MB。"); return; }
    try { importText(await file.text()); } catch (e) { S.status("無法匯入：" + e.message); }
  }

  // ---- DOM wiring ---------------------------------------------------------------------------
  function bind() {
    const host = $("flow-host");
    $("run").onclick = () => runQueue();
    $("cancel-run").onclick = () => { if (st.ex && st.running) { st.ex.cancel(); S.status("正在取消…"); } };
    $("estimate").onclick = showEstimate;
    $("load").onclick = loadPreset;
    $("json").onclick = exportJson;
    $("import-flow").onclick = () => $("flow-file").click();
    $("flow-file").onchange = e => { const f = e.target.files[0]; e.target.value = ""; importFile(f); };
    $("fit-view").onclick = () => { if (st.canvas) { S.showPanel(null); st.canvas.fit(); App.focusCanvas(); } };
    $("palette-filter").oninput = renderLibrary;
    $("library-toggle").addEventListener("click", () => { if (st.graph) { sync(); renderLibrary(); renderReuse(); } });
    $("props-toggle").addEventListener("click", () => renderInspector());
    $("history-toggle").addEventListener("click", () => renderHistory());
    $("shortcuts").onclick = () => { const d = $("shortcut-help"); if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); };
    // Palette drops (MIME) are handled by the canvas and reach us via onDropType;
    // .json file drops are caught here before the canvas sees them.
    const isFileDrag = e => { const types = [...(e.dataTransfer && e.dataTransfer.types || [])]; return types.includes("Files") && !types.includes(MIME); };
    host.addEventListener("dragover", e => {
      if (!st.graph || !isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "copy"; host.classList.add("sga-drop");
    }, true);
    host.addEventListener("dragleave", e => { if (!host.contains(e.relatedTarget)) host.classList.remove("sga-drop"); }, true);
    host.addEventListener("drop", e => {
      if (!st.graph || !isFileDrag(e)) return;
      e.preventDefault(); e.stopPropagation(); host.classList.remove("sga-drop");
      const file = [...e.dataTransfer.files].find(f => /\.json$/i.test(f.name) || f.type === "application/json");
      if (file) importFile(file); else S.status("只能匯入 .json 流程檔。");
    }, true);
    host.addEventListener("pointerdown", () => { const p = S.getPanel(); if (p === "library" || p === "options") S.showPanel(null); });
    root.addEventListener("pagehide", saveNow);
    root.addEventListener("beforeunload", saveNow);
  }

  function init() {
    const ok = S && SG.Graph && SG.Executor && SG.registry && SG.types && SG.Canvas && SG.nodes && SG.migrate && SG.runs;
    const host = doc && $("flow-host");
    if (!ok) {
      if (host) {
        const p = doc.createElement("p");
        p.className = "sga-fallback";
        p.textContent = "流程引擎未載入：請確認 comfy/ 資料夾與 HTML 放在一起。";
        host.replaceChildren(p);
      }
      return;
    }
    SG.nodes.registerAll(SG);
    SG.nodes.loadWorkflow = id => resolveWorkflow(id).json;
    sync();
    bind();
    host.replaceChildren();
    App.ready = true;
  }
  init();
})(globalThis);
