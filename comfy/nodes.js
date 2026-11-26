/* 小海 Agent 工作室 — domain node library (DOM-free).
 * Reproduces the v0.5 simulate() behaviour as registry nodes and turns the
 * Agent / Skill / Tool catalogues into live node types. */
(function (root) {
  "use strict";
  const SG = root.SeaGraph = root.SeaGraph || {};
  const N = SG.nodes = SG.nodes || {};

  // ---- data duplicated from the inline script (kept DOM-free) -------------
  N.catalog = {
    cargo: { title: "Cargo Book：cargo test", url: "https://doc.rust-lang.org/cargo/commands/cargo-test.html", terms: "rust cargo test 測試 編譯" },
    worktree: { title: "Git：git worktree", url: "https://git-scm.com/docs/git-worktree", terms: "git worktree 工作樹 分支" },
    go: { title: "Go：go test", url: "https://pkg.go.dev/cmd/go#hdr-Test_packages", terms: "go golang 測試 編譯" },
    maven: { title: "Apache Maven：Build Lifecycle", url: "https://maven.apache.org/guides/introduction/introduction-to-the-lifecycle.html", terms: "java maven jvm 測試 編譯" }
  };
  N.toolOps = { query: "查詢", read: "讀取檔案", write: "寫入檔案" };
  N.toolBadges = { query: "查", read: "讀", write: "寫" };

  N.typeDefs = {
    QUERY: { label: "查詢詞", color: "#f2c14e" },
    SOURCES: { label: "來源清單", color: "#3fb8f0" },
    SUMMARY: { label: "研究摘要", color: "#79d48a", accepts: ["SUMMARY", "ARTIFACT"] },
    PROJECT_RUST: { label: "Rust 專案", color: "#e8875b" },
    BUILD_RUST: { label: "Rust 編譯結果", color: "#f6b48f" },
    PROJECT_GO: { label: "Go 專案", color: "#3ccfc0" },
    BUILD_GO: { label: "Go 編譯結果", color: "#97e6dd" },
    PROJECT_JAVA: { label: "Java 專案", color: "#d68ad6" },
    BUILD_JAVA: { label: "Java 編譯結果", color: "#b9a3e3" },
    REPORT: { label: "測試報告", color: "#ff8fa3" },
    ARTIFACT: { label: "產出物", color: "#c5e88d" },
    AGENT_CTX: { label: "Agent 脈絡", color: "#a4b6ff" },
    SKILL_REF: { label: "Skill 引用", color: "#acccae" },
    TOOL_REF: { label: "Tool 引用", color: "#95bde8" }
  };

  // Legacy v0.5 kinds -> node types. Shared with migrate.js.
  const toolchains = { Rust: { build: "cargo build", test: "cargo test" }, Go: { build: "go build ./...", test: "go test ./..." }, Java: { build: "mvn compile", test: "mvn verify" } };
  const spec = [
    { kind: "query", type: "search/query", group: "搜尋", title: "查詢", hint: "從預載官方索引尋找來源",
      input: null, output: { name: "query", type: "QUERY", label: "查詢詞" },
      widget: { name: "query", label: "查詢詞", default: "Rust 測試" } },
    { kind: "read", type: "search/read", group: "搜尋", title: "讀取來源", hint: "從索引取得可追溯引用",
      input: { name: "query", type: "QUERY", label: "查詢詞" }, output: { name: "sources", type: "SOURCES", label: "來源清單" },
      widget: null },
    { kind: "cite", type: "search/cite", group: "搜尋", title: "整理引用", hint: "整理標題、網址與交接重點",
      input: { name: "sources", type: "SOURCES", label: "來源清單" }, output: { name: "summary", type: "SUMMARY", label: "研究摘要" },
      widget: { name: "purpose", label: "交接目的", default: "給 Coding 專才參考" }, output_node: true }
  ];
  for (const group of Object.keys(toolchains)) {
    const lang = group.toLowerCase(), up = group.toUpperCase();
    spec.push(
      { kind: lang + "-read", type: "code/" + lang + "-read", group, title: group + " 讀取專案", hint: "帶入專案設定及可選引用",
        input: { name: "summary", type: "SUMMARY", label: "研究摘要", optional: true },
        output: { name: "project", type: "PROJECT_" + up, label: group + " 專案" },
        widget: { name: "workdir", label: "工作目錄（示範）", default: "/demo/worktrees/" + lang } },
      { kind: lang + "-build", type: "code/" + lang + "-build", group, title: group + " 編譯", hint: "模擬編譯並保留輸出",
        input: { name: "project", type: "PROJECT_" + up, label: group + " 專案" },
        output: { name: "build", type: "BUILD_" + up, label: group + " 編譯結果" },
        widget: { name: "command", label: "建置指令（不執行）", default: toolchains[group].build }, writes: true },
      { kind: lang + "-test", type: "code/" + lang + "-test", group, title: group + " 測試", hint: "產生可追蹤的示範報告",
        input: { name: "build", type: "BUILD_" + up, label: group + " 編譯結果" },
        output: { name: "report", type: "REPORT", label: "測試報告" },
        widget: { name: "command", label: "測試指令（不執行）", default: toolchains[group].test }, writes: true, output_node: true,
        extra: [{ name: "flaky", kind: "number", label: "模擬暫時失敗次數", default: 0, min: 0, max: 3, step: 1 }] },
      { kind: lang + "-fix", type: "code/" + lang + "-fix", group, title: group + " 修正程式", hint: "依測試報告修正程式（模擬，不改檔）",
        input: { name: "report", type: "REPORT", label: "測試報告" },
        output: { name: "project", type: "PROJECT_" + up, label: group + " 專案" },
        widget: { name: "note", label: "修正方針", default: "依測試報告修正" }, writes: true, v06: true }
    );
  }
  N.spec = spec;
  N.byKind = {};
  N.byType = {};
  for (const s of spec) { N.byKind[s.kind] = s; N.byType[s.type] = s; }
  /** v0.5 preset layouts (kind, x, y) — duplicated from the inline `presets`. */
  N.v05Presets = {
    rust: [["query", 20, 24], ["read", 219, 24], ["cite", 419, 24], ["rust-read", 20, 244], ["rust-build", 219, 244], ["rust-test", 419, 244]],
    research: [["query", 20, 60], ["read", 219, 60], ["cite", 419, 60]],
    go: [["go-read", 20, 60], ["go-build", 219, 60], ["go-test", 419, 60]],
    java: [["java-read", 20, 60], ["java-build", 219, 60], ["java-test", 419, 60]],
    empty: []
  };

  // ---- helpers -------------------------------------------------------------
  function abortError() { const e = new Error("已取消"); e.name = "AbortError"; return e; }
  function checkAbort(ctx) { if (ctx && ctx.signal && ctx.signal.aborted) throw abortError(); }
  function nodeId(ctx) { return (ctx && ctx.node && ctx.node.id) || (ctx && ctx.nodeId) || null; }
  function str(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (typeof v === "object") {
      if (typeof v.query === "string") return v.query;
      if (typeof v.value === "string" || typeof v.value === "number") return String(v.value);
      if (typeof v.text === "string") return v.text;
    }
    return "";
  }
  /** Widget value, preferring a converted-widget input when one is wired. */
  function widget(inputs, ctx, name, fallback) {
    if (inputs && inputs[name] !== undefined && inputs[name] !== null) return str(inputs[name]);
    const w = (ctx && ctx.widgets) || (ctx && ctx.node && ctx.node.widgets) || {};
    return w[name] !== undefined ? str(w[name]) : (fallback || "");
  }
  function progress(ctx, v, text) { if (ctx && typeof ctx.progress === "function") ctx.progress(v, text); }
  function tick() { return new Promise(r => (typeof setTimeout === "function" ? setTimeout(r, 0) : r())); }
  function sourcesOf(v) { return v && Array.isArray(v.sources) ? v.sources.map(s => ({ title: s.title, url: s.url })) : undefined; }
  function asMap(x) {
    if (!x) return new Map();
    if (x instanceof Map) return x;
    if (Array.isArray(x)) return new Map(x.filter(Boolean).map(i => [i.id, i]));
    return new Map(Object.entries(x));
  }
  function opKey(v) {
    if (Object.prototype.hasOwnProperty.call(N.toolOps, v)) return v;
    for (const k of Object.keys(N.toolOps)) if (N.toolOps[k] === v) return k;
    return null;
  }
  N.opKey = opKey;

  // ---- simulate() reproduction ---------------------------------------------
  function makeExecute(s) {
    return async function execute(inputs, ctx) {
      inputs = inputs || {};
      checkAbort(ctx);
      const id = nodeId(ctx);
      progress(ctx, 0.15, "準備中");
      if (s.input && !s.input.optional && (inputs[s.input.name] === undefined || inputs[s.input.name] === null))
        throw new Error("缺少輸入：" + s.input.label);
      const incoming = s.input ? inputs[s.input.name] : null;
      const val = s.widget ? widget(inputs, ctx, s.widget.name, "").trim() : "";
      await tick();
      checkAbort(ctx);
      progress(ctx, 0.6, "處理中");
      let out;
      if (s.kind === "query") {
        if (!val) throw new Error("查詢詞不能留白");
        out = { text: "已準備查詢：" + val, query: val };
      } else if (s.kind === "read") {
        const q = str(incoming);
        const tokens = q.toLowerCase().split(/[\s,，、]+/).filter(Boolean);
        const sources = Object.values(N.catalog).filter(a => tokens.some(t => a.terms.includes(t))).map(a => ({ title: a.title, url: a.url }));
        if (!sources.length) throw new Error("預載索引沒有命中，請換關鍵字");
        out = { text: "本機索引找到 " + sources.length + " 筆官方文件", sources };
      } else if (s.kind === "cite") {
        const list = sourcesOf(incoming) || [];
        out = { text: (val || "研究交接") + "：整理 " + list.length + " 筆引用", sources: list };
      } else if (/-read$/.test(s.kind)) {
        if (!val) throw new Error("請設定示範工作目錄");
        out = { text: "套用 " + s.group + " 示範目錄 " + val, sources: sourcesOf(incoming) };
      } else if (/-fix$/.test(s.kind)) {
        const failed = Boolean(incoming && incoming.failed);
        out = failed
          ? { text: (val || "依測試報告修正") + "：已修正 " + s.group + " 程式（模擬） · 真實修改 NOT_RUN", sources: sourcesOf(incoming), fixed: true }
          : { text: "測試通過，無需修正 " + s.group + " 程式", sources: sourcesOf(incoming) };
      } else {
        if (!val) throw new Error("請設定示範指令");
        if (/-test$/.test(s.kind)) {
          // Deterministic flaky demo: the first `flaky` attempts fail. Inside a loop
          // the iteration index counts as an attempt and the failure is reported
          // softly so loop-end / code/<lang>-fix can react to it.
          const flaky = Math.max(0, Math.min(3, Math.floor(Number(widget(inputs, ctx, "flaky", "0")) || 0)));
          const iter = ctx && ctx.iteration && Number.isFinite(ctx.iteration.index) ? ctx.iteration.index : 0;
          const attempt = (Number(ctx && ctx.attempt) || 0) + iter;
          if (attempt < flaky) {
            if (ctx && ctx.iteration) {
              out = { text: "測試暫時失敗（模擬）", sources: sourcesOf(incoming), failed: true, producedBy: id };
              progress(ctx, 1, "測試暫時失敗");
              const soft = {}; soft[s.output.name] = out; return soft;
            }
            throw new Error("測試暫時失敗（模擬）");
          }
        }
        out = { text: "模擬「" + val + "」 · 真實執行 NOT_RUN", sources: sourcesOf(incoming) };
      }
      if (out.sources === undefined) delete out.sources;
      out.producedBy = id;
      progress(ctx, 1, "完成");
      const result = {};
      result[s.output.name] = out;
      return result;
    };
  }
  function makeEstimate(s) {
    return function estimate(values) {
      const v = values || {};
      const text = s.widget ? str(v[s.widget.name] !== undefined ? v[s.widget.name] : s.widget.default) : "";
      const base = { query: [40, 120], read: [600, 400], cite: [900, 500] }[s.kind];
      if (base) return { tokens: base[0] + text.length * 2, ms: base[1], writes: false };
      if (/-read$/.test(s.kind)) return { tokens: 300 + text.length, ms: 300, writes: false };
      if (/-build$/.test(s.kind)) return { tokens: 200, ms: 1500, writes: true };
      if (/-fix$/.test(s.kind)) return { tokens: 1800, ms: 2000, writes: true };
      return { tokens: 400, ms: 2500, writes: true };
    };
  }
  function domainDef(s) {
    const def = {
      type: s.type, title: s.title, category: s.group, hint: s.hint,
      inputs: s.input ? [Object.assign({}, s.input)] : [],
      outputs: [Object.assign({}, s.output)],
      widgets: (s.widget ? [{ name: s.widget.name, kind: "text", label: s.widget.label, default: s.widget.default, maxLength: 220, convertible: true }] : [])
        .concat((s.extra || []).map(w => Object.assign({}, w))),
      estimate: makeEstimate(s),
      execute: makeExecute(s)
    };
    if (s.output_node) def.output = true;
    return def;
  }

  // ---- registration ----------------------------------------------------------
  let bound = null;
  const dynamic = new Set();
  function put(S, def) {
    try { if (S.registry.get(def.type) && S.registry.unregister) S.registry.unregister(def.type); } catch (e) { /* ignore */ }
    S.registry.register(def);
  }
  N.registerAll = function registerAll(S) {
    S = S || SG;
    bound = S;
    for (const id of Object.keys(N.typeDefs)) {
      let have = null;
      try { have = S.types.get(id); } catch (e) { have = null; }
      if (!have) S.types.define(id, Object.assign({}, N.typeDefs[id]));
    }
    for (const s of spec) put(S, domainDef(s));
    return S;
  };

  N.loadWorkflow = null; // hook: (agentId) -> workflow JSON | null
  N.maxDepth = 3;

  function skillDef(skill) {
    const id = skill.id;
    return {
      type: "skill/" + id, title: "Skill " + id, category: "Skills",
      hint: skill.description || id,
      inputs: [], outputs: [{ name: "skill", type: "SKILL_REF", label: "Skill 引用" }], widgets: [],
      estimate: () => ({ tokens: Math.min(4000, Math.round(((skill.source || "").length || 200) / 3)), ms: 50, writes: false }),
      execute: async function (inputs, ctx) {
        checkAbort(ctx); progress(ctx, 0.5, "載入 Skill");
        return { skill: { text: "Skill " + id + "：" + (skill.description || ""), skillId: id, producedBy: nodeId(ctx) } };
      }
    };
  }
  function toolDef(tool) {
    const ops = (tool.operations || []).filter(op => N.toolOps[op]);
    const badges = ops.map(op => "［" + N.toolBadges[op] + "］").join("");
    const options = ops.map(op => N.toolOps[op]);
    return {
      type: "tool/" + tool.id, title: tool.name || tool.id, category: "Tools",
      hint: badges + " " + (tool.description || tool.id) + (ops.includes("write") ? " · 可寫入" : " · 唯讀"),
      inputs: [], outputs: [{ name: "tool", type: "TOOL_REF", label: "Tool 引用" }],
      widgets: options.length ? [{ name: "operation", kind: "select", label: "操作", default: options[0], options }] : [],
      toolOps: ops,
      estimate: values => ({ tokens: 80, ms: 100, writes: opKey(values && values.operation !== undefined ? values.operation : options[0]) === "write" }),
      execute: async function (inputs, ctx) {
        checkAbort(ctx); progress(ctx, 0.5, "檢查工具");
        const op = opKey(widget(inputs, ctx, "operation", options[0] || "")) || ops[0] || null;
        return { tool: { text: "Tool " + (tool.name || tool.id) + "：" + (op ? N.toolOps[op] : "未選操作") + "（設定預覽，未呼叫工具）",
          toolId: tool.id, operation: op, writes: op === "write", producedBy: nodeId(ctx) } };
      }
    };
  }
  function nestedWorkflow(json, depth, ancestors) {
    const copy = JSON.parse(JSON.stringify(json));
    for (const n of copy.nodes || []) if (typeof n.type === "string" && n.type.indexOf("agent/") === 0) n.props = Object.assign({}, n.props, { depth, ancestors });
    return copy;
  }

  /** Static checks across sub-agent workflows: self/cyclic references and permission issues
   *  inside nested workflows, attributed to the top-level agent node that pulls them in. */
  N.subflowIssues = function subflowIssues(graph, profiles, opts) {
    const S = bound || SG;
    const out = [];
    const load = typeof N.loadWorkflow === "function" ? N.loadWorkflow : null;
    const top = graph && graph.agent ? [graph.agent] : [];
    function walk(g, chain, depth, rootId) {
      for (const n of (g && g.nodes) || []) {
        if (typeof n.type !== "string" || n.type.indexOf("agent/") !== 0) continue;
        const aid = n.type.slice(6), at = rootId || n.id;
        if (chain.indexOf(aid) >= 0) {
          out.push({ level: "error", nodeId: at, message: "子流程循環引用：" + chain.concat(aid).join(" → ") + "（會無限遞迴）" });
          continue;
        }
        if (!load || !S.Graph || depth >= N.maxDepth) continue;
        const json = load(aid);
        if (!json || !(json.nodes || []).length) continue;
        let sub;
        try { sub = new S.Graph(json); } catch (e) { continue; }
        for (const i of N.permissionIssues(sub, profiles, opts))
          out.push({ level: i.level, nodeId: at, message: "子流程「" + aid + "」：" + i.message });
        walk(sub, chain.concat(aid), depth + 1, at);
      }
    }
    walk(graph, top, 0, null);
    return out;
  };
  function agentDef(agent) {
    const id = agent.id, name = agent.name || id;
    return {
      type: "agent/" + id, title: name, category: "Agents",
      hint: (agent.role || agent.detail || "Agent") + " · 可展開為子流程",
      inputs: [
        { name: "skill", type: "SKILL_REF", label: "Skill", optional: true },
        { name: "tool", type: "TOOL_REF", label: "Tool", optional: true },
        { name: "summary", type: "SUMMARY", label: "研究摘要", optional: true }
      ],
      outputs: [{ name: "artifact", type: "ARTIFACT", label: "產出物" }, { name: "context", type: "AGENT_CTX", label: "Agent 脈絡" }],
      widgets: [{ name: "task", kind: "textarea", label: "任務說明", default: "", maxLength: 2000 }],
      output: true,
      agentId: id,
      estimate: () => ({ tokens: 1500, ms: 3000, writes: false }),
      execute: async function (inputs, ctx) {
        inputs = inputs || {};
        checkAbort(ctx);
        const S = bound || SG;
        const me = nodeId(ctx);
        const props = (ctx && ctx.node && ctx.node.props) || {};
        // ctx.depth comes from the executor (0 at top level); props.depth/ancestors are stamped
        // onto agent nodes of nested workflows. Take the larger so the guard can't be bypassed.
        const depth = Math.max(Number(ctx && ctx.depth) || 0, Number(props.depth) || 0);
        const topAgent = ctx && ctx.graph && ctx.graph.agent;
        const ancestors = Array.isArray(props.ancestors) ? props.ancestors : (topAgent ? [topAgent] : []);
        if (ancestors.indexOf(id) >= 0) throw new Error("子流程循環引用：" + ancestors.concat(id).join(" → ") + "（已停止）");
        const task = widget(inputs, ctx, "task", "").trim();
        const used = [];
        if (inputs.skill) used.push("Skill " + (inputs.skill.skillId || str(inputs.skill)));
        if (inputs.tool) used.push("Tool " + (inputs.tool.toolId || str(inputs.tool)) + (inputs.tool.operation ? "（" + N.toolOps[inputs.tool.operation] + "）" : ""));
        if (inputs.summary) used.push("研究摘要");
        const context = { text: "Agent「" + name + "」脈絡" + (used.length ? "：" + used.join("、") : "：無外部輸入"),
          agentId: id, skills: agent.skill_refs || [], tools: (agent.tool_refs || []).map(r => r.id), producedBy: me };
        let sources = sourcesOf(inputs.summary) || [];
        progress(ctx, 0.2, "準備子流程");
        let text;
        const json = typeof N.loadWorkflow === "function" && S.Graph && S.Executor ? N.loadWorkflow(id) : null;
        if (json && depth < N.maxDepth && (json.nodes || []).length) {
          const g = new S.Graph(nestedWorkflow(json, depth + 1, ancestors.concat(id)));
          const ex = new S.Executor(g, { registry: S.registry, depth: depth + 1, delay: () => Promise.resolve() });
          const onAbort = () => { try { ex.cancel(); } catch (e) { /* ignore */ } };
          if (ctx && ctx.signal && ctx.signal.addEventListener) ctx.signal.addEventListener("abort", onAbort, { once: true });
          let done = 0;
          if (ex.on) ex.on("node-done", () => { done++; progress(ctx, 0.2 + 0.7 * Math.min(1, done / Math.max(1, g.nodes.length)), "子流程 " + done + "/" + g.nodes.length); });
          // Approval gates inside the sub-workflow surface as an approval on THIS node,
          // so the parent run panel / canvas can answer them (otherwise the run hangs).
          if (ex.on) ex.on("node-wait", e => {
            if (!ctx || typeof ctx.requestApproval !== "function") { ex.approve(e.id, false, "上層流程無法核准"); return; }
            const title = (g.getNode(e.id) && g.getNode(e.id).title) || e.id;
            ctx.requestApproval({ message: "子流程「" + name + "」· " + title + "：" + e.message,
              details: Object.assign({ agentId: id, nodeId: e.id }, e.details || {}) })
              .then(ok => ex.approve(e.id, ok, ctx.approvalNote), () => { /* aborted: onAbort cancels nested run */ });
          });
          let res;
          try { res = await ex.queue({ targets: g.nodes.map(n => n.id) }); }
          finally { if (ctx && ctx.signal && ctx.signal.removeEventListener) ctx.signal.removeEventListener("abort", onAbort); }
          checkAbort(ctx);
          if (res.status === "cancelled") throw abortError();
          const results = res.results || [];
          const ok = results.filter(r => r.status === "done" || r.status === "cached").length;
          const failed = results.find(r => r.status === "error");
          if (failed) throw new Error("子流程未通過：" + (failed.text || "節點錯誤"));
          for (const r of results) for (const v of Object.values(r.outputs || {})) for (const s of (v && v.sources) || []) if (!sources.some(x => x.url === s.url)) sources.push({ title: s.title, url: s.url });
          text = "Agent「" + name + "」子流程完成 " + ok + "/" + results.length + " 個節點（第 " + (depth + 1) + " 層）";
        } else {
          text = "Agent「" + name + "」整理交付" + (task ? "：" + task : "") + (used.length ? "（使用 " + used.join("、") + "）" : "") +
            (json && depth >= N.maxDepth ? " · 已達子流程深度上限 " + N.maxDepth : "") + " · 真實執行 NOT_RUN";
        }
        progress(ctx, 1, "完成");
        const artifact = { text, producedBy: me };
        if (sources.length) artifact.sources = sources;
        return { artifact, context };
      }
    };
  }

  /** (Re)register agent/<id>, skill/<id>, tool/<id> from the live catalogues. */
  N.syncCatalog = function syncCatalog(cat) {
    const S = bound || SG;
    if (!S.registry) return [];
    cat = cat || {};
    const next = [];
    for (const s of asMap(cat.skills).values()) if (s && s.id) next.push(skillDef(s));
    for (const t of asMap(cat.tools).values()) if (t && t.id) next.push(toolDef(t));
    for (const a of asMap(cat.profiles).values()) if (a && a.id) next.push(agentDef(a));
    const keep = new Set(next.map(d => d.type));
    for (const type of Array.from(dynamic)) if (!keep.has(type)) { try { S.registry.unregister(type); } catch (e) { /* ignore */ } dynamic.delete(type); }
    for (const def of next) { put(S, def); dynamic.add(def.type); }
    return next.map(d => d.type);
  };

  /** Validate-style issues for write operations wired into agents granted read only. */
  N.permissionIssues = function permissionIssues(graph, profiles, opts) {
    const issues = [];
    if (!graph) return issues;
    const nodes = graph.nodes || [], links = graph.links || [];
    const byId = new Map(nodes.map(n => [n.id, n]));
    const agents = asMap(profiles);
    const check = opts && typeof opts.configurationCheck === "function" ? opts.configurationCheck : null;
    const isVirtual = n => n && /(^|\/)reroute$/.test(n.type);
    function sourceOf(link, seen) {
      let n = byId.get(link.from);
      seen = seen || new Set();
      while (isVirtual(n) && !seen.has(n.id)) {
        seen.add(n.id);
        const up = links.find(l => l.to === n.id);
        if (!up) return null;
        n = byId.get(up.from);
      }
      return n || null;
    }
    for (const link of links) {
      const target = byId.get(link.to);
      if (!target || typeof target.type !== "string" || target.type.indexOf("agent/") !== 0 || link.in !== "tool") continue;
      const src = sourceOf(link);
      if (!src || typeof src.type !== "string" || src.type.indexOf("tool/") !== 0) continue;
      if (src.mode === "mute" || target.mode === "mute") continue;
      const toolId = src.type.slice(5), agentId = target.type.slice(6);
      const op = opKey(src.widgets && src.widgets.operation);
      const agent = agents.get(agentId);
      if (!op || !agent) continue;
      const agentName = agent.name || agentId;
      let allowed;
      if (check) {
        const review = (check(agent).toolReview || []).find(r => r.id === toolId);
        allowed = Boolean(review && !review.missing && review.checks && review.checks[op]);
      } else {
        const ref = (agent.tool_refs || []).find(r => r.id === toolId);
        allowed = Boolean(ref && (ref.operations || []).includes(op));
      }
      if (allowed) continue;
      const granted = ((agent.tool_refs || []).find(r => r.id === toolId) || {}).operations || [];
      const grantText = granted.length ? granted.map(o => N.toolOps[o] || o).join("、") : "無";
      if (op === "write") {
        issues.push({ level: "error", nodeId: target.id, slot: "tool",
          message: "權限不符：「" + agentName + "」對 Tool「" + toolId + "」只被授權 " + grantText + "，不能接上寫入操作。" });
      } else {
        issues.push({ level: "warn", nodeId: target.id, slot: "tool",
          message: "權限提醒：「" + agentName + "」未被授權 Tool「" + toolId + "」的" + N.toolOps[op] + "。" });
      }
    }
    return issues;
  };
})(globalThis);
