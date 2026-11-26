/* SeaGraph executor: sequential queue, dirty-only cache, events, abort,
 * bypass/mute, approval gates. DOM-free classic script (also loads in Node).
 * See "Contract notes" at the top of comfy/graph.js.
 */
(function (root) {
  "use strict";
  const SG = root.SeaGraph = root.SeaGraph || {};
  if (!SG.Emitter || !SG.Graph) throw new Error("SeaGraph: load comfy/graph.js before comfy/executor.js");

  function now() {
    const p = root.performance;
    return p && typeof p.now === "function" ? p.now() : 0;
  }
  function abortError() {
    const e = new Error("已取消");
    e.name = "AbortError";
    return e;
  }
  function errText(e) { return e && e.message ? String(e.message) : String(e); }

  /** Resolve/reject with `promise`, or reject with AbortError as soon as `signal` aborts. */
  function raceAbort(promise, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise(function (resolve, reject) {
      const onAbort = function () { reject(abortError()); };
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(
        function (v) { signal.removeEventListener("abort", onAbort); resolve(v); },
        function (e) { signal.removeEventListener("abort", onAbort); reject(e); }
      );
    });
  }

  const SKIP_TEXT = { mute: "已靜音，略過。", upstream: "上游節點未完成，略過。", branch: "未選中的分支，略過。", cancelled: "已取消。" };
  function loopMax(node) {
    const n = Math.floor(Number(node && node.widgets ? node.widgets.max : 3));
    return Math.max(1, Math.min(SG.control.MAX_LOOP, Number.isFinite(n) ? n : 3));
  }

  class Executor extends SG.Emitter {
    constructor(graph, opts) {
      super();
      opts = opts || {};
      this.graph = graph;
      this.registry = opts.registry || graph.registry || SG.registry;
      this.types = opts.types || SG.types;
      this.delay = typeof opts.delay === "function" ? opts.delay : function () { return Promise.resolve(); };
      this.stepMs = Number.isFinite(opts.stepMs) ? opts.stepMs : 200;
      this.depth = opts.depth || 0;
      this._cache = new Map();   // id -> {key, outputs}
      this._jobs = [];
      this._current = null;
      this._pumping = false;
      this._seq = 0;
      this._waits = new Map();   // id -> {message, details, resolve, reject, ctx}
      this.lastResult = null;
    }

    get running() { return !!this._current; }
    get queued() { return this._jobs.length + (this._current ? 1 : 0); }

    queue(opts) {
      opts = opts || {};
      const job = {
        runId: "r" + (++this._seq),
        targets: Array.isArray(opts.targets) ? opts.targets.slice() : undefined,
        dryRun: !!opts.dryRun,
        cancelled: false
      };
      const p = new Promise(function (res) { job.resolve = res; });
      this._jobs.push(job);
      this.emit("queue", { pending: this.queued });
      if (!this._pumping) {
        this._pumping = true;
        const self = this;
        Promise.resolve().then(function () { return self._pump(); });
      }
      return p;
    }

    async _pump() {
      this._pumping = true;
      while (this._jobs.length) {
        const job = this._jobs.shift();
        this._current = job;
        let r;
        try { r = await this._run(job); }
        catch (e) {
          r = { runId: job.runId, status: "error", order: [], snapshot: null, results: [], message: errText(e) };
          this.emit("run-end", r);
        }
        this._current = null;
        this._ctrl = null;
        this.lastResult = r;
        this.emit("queue", { pending: this.queued });
        job.resolve(r);
      }
      this._pumping = false;
    }

    cancel() {
      const dropped = this._jobs.splice(0, this._jobs.length);
      if (this._current) this._current.cancelled = true;
      if (this._ctrl) this._ctrl.abort();
      const self = this;
      dropped.forEach(function (job) {
        const r = { runId: job.runId, status: "cancelled", order: [], snapshot: null, results: [] };
        self.emit("run-end", r);
        job.resolve(r);
      });
      if (dropped.length) this.emit("queue", { pending: this.queued });
    }

    clearCache(ids) {
      if (ids == null) { this._cache.clear(); return; }
      (Array.isArray(ids) ? ids : [ids]).forEach((id) => this._cache.delete(id));
    }

    output(id) { const c = this._cache.get(id); return c ? c.outputs : undefined; }

    /** Outermost loop whose region holds `id` (excluding that loop's own end). */
    _loopOwner(id, info) {
      info = info || this.graph.loops();
      let best = null;
      info.loops.forEach(function (L) {
        if (L.region.has(id) && L.endId !== id && (!best || L.depth < best.depth)) best = L;
      });
      return best;
    }

    isDirty(id, _info) {
      const n = this.graph.getNode(id);
      const def = n && this.registry.get(n.type);
      const owner = this._loopOwner(id, _info);
      if (owner) return this.isDirty(owner.endId, _info);
      if (def && def.nocache) return true;
      const c = this._cache.get(id);
      return !c || c.key !== this._key(id, new Map());
    }

    // ------------------------------------------------------------ approvals
    pending() {
      const out = [];
      this._waits.forEach(function (w, id) { out.push({ id: id, message: w.message, details: w.details }); });
      return out;
    }

    approve(nodeId, approved, note) {
      const w = this._waits.get(nodeId);
      if (!w) return false;
      this._waits.delete(nodeId);
      w.ctx.approvalNote = note == null ? "" : String(note);
      w.resolve(!!approved);
      return true;
    }

    _requestApproval(id, ctx, signal, spec) {
      spec = spec || {};
      const self = this;
      if (signal.aborted) return Promise.reject(abortError());
      const message = spec.message == null ? "請確認是否繼續" : String(spec.message);
      const details = spec.details;
      return new Promise(function (resolve, reject) {
        const onAbort = function () { self._waits.delete(id); reject(abortError()); };
        signal.addEventListener("abort", onAbort, { once: true });
        self._waits.set(id, {
          message: message, details: details, ctx: ctx,
          resolve: function (v) { signal.removeEventListener("abort", onAbort); resolve(v); }
        });
        self.emit("node-wait", { id: id, message: message, details: details });
      });
    }

    // ------------------------------------------------------------ cache keys
    _key(id, memo, stack) {
      if (memo.has(id)) return memo.get(id);
      const g = this.graph;
      const n = g.getNode(id);
      if (!n) return "none";
      stack = stack || new Set();
      if (stack.has(id)) return "cycle";
      stack.add(id);
      const def = this.registry.get(n.type);
      const conv = new Set(n.converted || []);
      const ins = {};
      const self = this;
      g.slots(id).inputs.forEach(function (s) {
        const src = g.inputSource(id, s.name);
        if (!src) { ins[s.name] = null; return; }
        let k = self._key(src.node, memo, stack) + "." + src.out;
        const sn = g.getNode(src.node);
        const sdef = sn && self.registry.get(sn.type);
        if (sdef && sdef.nocache) {
          const c = self._cache.get(src.node);
          k += ":" + (c ? SG.hash(SG.stableStringify(c.outputs ? c.outputs[src.out] : null)) : "none");
        }
        ins[s.name] = k;
      });
      const widgets = {};
      Object.keys(n.widgets || {}).forEach(function (k) { if (!conv.has(k)) widgets[k] = n.widgets[k]; });
      const key = SG.hash({
        id: id, type: n.type, mode: n.mode, widgets: widgets, converted: Array.from(conv).sort(),
        props: n.props, ins: ins, ver: def && def.version != null ? def.version : null
      });
      stack.delete(id);
      memo.set(id, key);
      return key;
    }

    // -------------------------------------------------------------- estimate
    estimate(opts) {
      const g = this.graph;
      const self = this;
      let order;
      try { order = g.order(opts && opts.targets); }
      catch (e) { order = g.nodes.filter(function (n) { const d = self.registry.get(n.type); return !(d && d.virtual); }).map(function (n) { return n.id; }); }
      const res = { tokens: 0, ms: 0, writes: false, perNode: {}, full: { tokens: 0, ms: 0, writes: false } };
      const info = g.loops();
      order.forEach(function (id) {
        const n = g.getNode(id);
        const def = n && self.registry.get(n.type);
        if (!def || n.mode !== "normal") return;
        let est = { tokens: 0, ms: 0, writes: false };
        if (typeof def.estimate === "function") {
          try {
            const e = def.estimate(Object.assign({}, n.widgets), n) || {};
            est = { tokens: Number(e.tokens) || 0, ms: Number(e.ms) || 0, writes: !!e.writes };
          } catch (err) { /* estimate is advisory */ }
        }
        // body nodes run once per iteration: scale by every enclosing loop's max
        let factor = 1;
        info.loops.forEach(function (L) {
          if (L.region.has(id) && L.endId !== id) factor *= loopMax(g.getNode(L.startId));
        });
        est.tokens *= factor; est.ms *= factor;
        const cached = !self.isDirty(id, info);
        res.perNode[id] = { tokens: est.tokens, ms: est.ms, writes: est.writes, cached: cached };
        res.full.tokens += est.tokens; res.full.ms += est.ms; res.full.writes = res.full.writes || est.writes;
        if (!cached) { res.tokens += est.tokens; res.ms += est.ms; res.writes = res.writes || est.writes; }
      });
      return res;
    }

    // ------------------------------------------------------------------- run
    async _run(job) {
      const g = this.graph, reg = this.registry, T = this.types;
      const runId = job.runId;
      const self = this;
      const snapshot = g.toJSON();
      const ctrl = new AbortController();
      this._ctrl = ctrl;
      if (job.cancelled) ctrl.abort();
      const signal = ctrl.signal;

      let order;
      try { order = g.order(job.targets); }
      catch (e) {
        const msg = errText(e);
        this.emit("run-start", { runId: runId, order: [] });
        const results = (e && e.ids || []).map(function (id) { return { id: id, status: "error", text: msg, outputs: undefined, key: null, ms: 0, attempts: 0 }; });
        const r = { runId: runId, status: "error", order: [], snapshot: snapshot, results: results, message: msg };
        this.emit("run-end", r);
        return r;
      }
      this.emit("run-start", { runId: runId, order: order.slice() });
      const keys = new Map();
      const keyOf = function (id) { return self._key(id, keys); };

      if (job.dryRun) {
        const issues = g.validate();
        const est = this.estimate({ targets: job.targets });
        const results = order.map(function (id) { return { id: id, status: "skipped", text: "試跑：未執行", outputs: undefined, key: keyOf(id), ms: 0, attempts: 0 }; });
        const r = {
          runId: runId, status: issues.some(function (i) { return i.level === "error"; }) ? "error" : "ok",
          order: order.slice(), snapshot: snapshot, results: results, dryRun: true, estimate: est, issues: issues
        };
        this.emit("run-end", r);
        return r;
      }

      const inOrder = new Set(order);
      const loopInfo = g.loops();
      const loopErrors = loopInfo.issues.filter(function (i) { return i.level === "error" && inOrder.has(i.nodeId); });
      if (loopErrors.length) {
        const bad = new Map();
        loopErrors.forEach(function (i) { if (!bad.has(i.nodeId)) bad.set(i.nodeId, i.message); });
        bad.forEach(function (message, id) { self.emit("node-error", { id: id, message: message }); });
        const results = order.map(function (id) {
          return bad.has(id)
            ? { id: id, status: "error", text: bad.get(id), outputs: undefined, key: keyOf(id), ms: 0, attempts: 0 }
            : { id: id, status: "skipped", reason: "blocked", text: "迴圈設定錯誤，未執行。", outputs: undefined, key: keyOf(id), ms: 0, attempts: 0 };
        });
        const r = { runId: runId, status: "error", order: order.slice(), snapshot: snapshot, results: results };
        this.emit("run-end", r);
        return r;
      }
      // loops that actually iterate in this run, and their nearest iterating parent
      const active = loopInfo.loops.filter(function (L) {
        const s = g.getNode(L.startId), e = g.getNode(L.endId);
        return inOrder.has(L.startId) && inOrder.has(L.endId) && s && e && s.mode === "normal" && e.mode === "normal";
      });
      const activeSet = new Set(active);
      const parentOf = new Map();
      active.forEach(function (L) {
        let p = L.parent;
        while (p && !activeSet.has(p)) p = p.parent;
        parentOf.set(L, p || null);
      });

      const CANCEL = { cancel: true };
      const state = new Map(); // id -> {status:"ok"|"skip"|"branch"|"error", outputs}
      const resMap = new Map();
      let failed = false;

      const setRes = function (id, r) { resMap.set(id, Object.assign({ id: id, outputs: undefined, key: null, ms: 0, attempts: 0 }, r)); };
      const firstText = function (id, outputs) {
        if (!outputs) return "";
        const outs = g.slots(id).outputs;
        if (outs.length) return SG.previewText(outputs[outs[0].name]);
        const k = Object.keys(outputs);
        return k.length ? SG.previewText(outputs[k[0]]) : "";
      };
      const skip = function (id, reason, message) {
        state.set(id, { status: reason === "branch" ? "branch" : "skip" });
        const payload = { id: id, reason: reason };
        if (message) payload.message = message;
        self.emit("node-skip", payload);
        setRes(id, { status: "skipped", reason: reason, text: message || SKIP_TEXT[reason] || "", key: keyOf(id) });
      };
      const pause = async function (ms) {
        try { await raceAbort(self.delay(ms), signal); } catch (e) { throw CANCEL; }
      };
      const gather = function (id, slots) {
        const gr = { inputs: {}, upstreamFail: null, branchReq: null, missing: null, inactive: [], linked: 0, active: 0, failed: 0 };
        slots.inputs.forEach(function (s) {
          const src = g.inputSource(id, s.name);
          if (!src) { if (!s.optional && !gr.missing) gr.missing = s; return; }
          gr.linked++;
          const st = state.get(src.node);
          let v;
          if (!st) { const c = self._cache.get(src.node); v = c && c.outputs ? c.outputs[src.out] : undefined; }
          else if (st.status === "branch") { gr.inactive.push(s.name); if (!s.optional && !gr.branchReq) gr.branchReq = s; return; }
          else if (st.status !== "ok") { gr.failed++; if (!s.optional && !gr.upstreamFail) gr.upstreamFail = s; return; }
          else v = st.outputs ? st.outputs[src.out] : undefined;
          if (SG.isInactive(v)) { gr.inactive.push(s.name); if (!s.optional && !gr.branchReq) gr.branchReq = s; return; }
          if (v === undefined) { if (!s.optional && !gr.missing) gr.missing = s; return; }
          gr.active++;
          gr.inputs[s.name] = v;
        });
        return gr;
      };
      const skipReason = function (gr) {
        if (gr.upstreamFail) return "upstream";
        if (gr.branchReq) return "branch";
        if (gr.linked > 0 && gr.active === 0 && (gr.failed || gr.inactive.length)) return gr.failed ? "upstream" : "branch";
        return null;
      };
      const fail = function (id, message, extra) {
        failed = true;
        state.set(id, { status: "error" });
        self.emit("node-error", { id: id, message: message });
        setRes(id, Object.assign({ status: "error", text: message, key: keyOf(id) }, extra || {}));
      };

      // -------------------------------------------------------- one node
      const runNode = async function (id, iter) {
        const node = g.getNode(id);
        if (!node) { state.set(id, { status: "skip" }); setRes(id, { status: "skipped", text: "節點已移除。" }); return; }
        const def = reg.get(node.type);
        const key = keyOf(id);
        const slots = g.slots(id);
        if (node.mode === "mute") { skip(id, "mute"); return; }
        const gr = gather(id, slots);
        const reason = skipReason(gr);

        if (node.mode === "bypass") {
          if (reason) { skip(id, reason); return; }
          const outputs = {};
          slots.outputs.forEach(function (o) {
            const hit = slots.inputs.find(function (s) { return gr.inputs[s.name] !== undefined && T.compatible(s.type, o.type); });
            outputs[o.name] = hit ? gr.inputs[hit.name] : undefined;
          });
          state.set(id, { status: "ok", outputs: outputs });
          self.emit("node-done", { id: id, outputs: outputs, cached: false, ms: 0, bypassed: true });
          setRes(id, { status: "done", text: firstText(id, outputs), outputs: outputs, key: key, bypassed: true });
          return;
        }
        if (!def || node.missing) { fail(id, "找不到節點類型「" + node.type + "」，無法執行。"); return; }
        if (reason) { skip(id, reason); return; }
        if (gr.missing) { failed = true; skip(id, "blocked", "缺少必要輸入「" + gr.missing.label + "」。"); return; }

        const c = self._cache.get(id);
        if (!iter && !def.nocache && c && c.key === key) {
          state.set(id, { status: "ok", outputs: c.outputs });
          self.emit("node-done", { id: id, outputs: c.outputs, cached: true, ms: 0 });
          setRes(id, { status: "cached", text: firstText(id, c.outputs), outputs: c.outputs, key: key });
          await pause(0);
          return;
        }

        const inputs = gr.inputs;
        const widgets = Object.assign({}, node.widgets);
        (node.converted || []).forEach(function (name) { if (inputs[name] !== undefined) widgets[name] = inputs[name]; });
        const retry = SG.control.normRetry(node.retry);
        const t0 = now();
        const ctx = {
          signal: signal, runId: runId, depth: self.depth, graph: g,
          node: JSON.parse(JSON.stringify({ id: node.id, type: node.type, title: node.title, mode: node.mode, props: node.props })),
          widgets: widgets,
          seed: SG.hash(id + SG.stableStringify(widgets)),
          attempt: 0,
          iteration: iter ? { index: iter.index, max: iter.max } : null,
          inactive: gr.inactive.slice(),
          approvalNote: "",
          progress: function (value, text) {
            if (signal.aborted) return;
            const v = Math.max(0, Math.min(1, Number(value) || 0));
            self.emit("node-progress", { id: id, value: v, text: text == null ? undefined : String(text) });
          },
          log: function (text) { self.emit("node-log", { id: id, text: String(text) }); },
          delay: function (ms) { return raceAbort(self.delay(ms), signal); },
          requestApproval: function (spec) { return self._requestApproval(id, ctx, signal, spec); }
        };
        self.emit("node-start", iter ? { id: id, iteration: ctx.iteration } : { id: id });
        let out, lastErr = null, attempt = 0;
        for (;;) {
          ctx.attempt = attempt;
          try {
            out = await raceAbort(Promise.resolve().then(function () {
              return typeof def.execute === "function" ? def.execute(inputs, ctx) : {};
            }), signal);
            lastErr = null;
            break;
          } catch (e) {
            self._waits.delete(id);
            if (signal.aborted) throw CANCEL;
            lastErr = e;
            if ((e && (e.name === "AbortError" || e.retryable === false)) || attempt >= retry.max) break;
            attempt++;
            self.emit("node-retry", { id: id, attempt: attempt, max: retry.max, message: errText(e) });
            await pause(retry.delay);
          }
        }
        const attempts = attempt + 1;
        if (lastErr) { fail(id, errText(lastErr), { ms: now() - t0, attempts: attempts }); return; }
        if (signal.aborted) throw CANCEL;
        if (out === undefined || out === null) out = {};
        else if (typeof out !== "object" || Array.isArray(out)) {
          const o = {};
          if (slots.outputs.length) o[slots.outputs[0].name] = out;
          out = o;
        }
        self._cache.set(id, { key: iter ? null : key, outputs: out });
        state.set(id, { status: "ok", outputs: out });
        const ms = now() - t0;
        const done = { id: id, outputs: out, cached: false, ms: ms, attempts: attempts };
        if (iter) done.iteration = ctx.iteration;
        self.emit("node-done", done);
        setRes(id, { status: "done", text: firstText(id, out), outputs: out, key: key, ms: ms, attempts: attempts });
        await pause(self.stepMs);
      };

      // -------------------------------------------------------- one loop
      const runLoop = async function (L, iter) {
        const S = L.startId, E = L.endId;
        const sNode = g.getNode(S), eNode = g.getNode(E);
        const keyE = keyOf(E);
        const regionIds = order.filter(function (id) { return L.region.has(id); });
        const bodyIds = order.filter(function (id) { return L.body.has(id); });
        const skipRest = function (reason) {
          regionIds.forEach(function (id) { if (id !== S) skip(id, reason === "branch" ? "branch" : "upstream"); });
        };
        const c = self._cache.get(E);
        if (!iter && c && c.region && c.key === keyE) {
          regionIds.forEach(function (id) {
            const rs = c.region[id];
            if (!rs) return;
            state.set(id, rs.state);
            if (rs.state.status === "ok") {
              self.emit("node-done", { id: id, outputs: rs.state.outputs, cached: true, ms: 0 });
              setRes(id, Object.assign({}, rs.result, { status: "cached", ms: 0, attempts: 0 }));
            } else {
              self.emit("node-skip", { id: id, reason: rs.result.reason });
              setRes(id, Object.assign({}, rs.result));
            }
          });
          await pause(0);
          return;
        }
        const gs = gather(S, g.slots(S));
        const rs = skipReason(gs);
        if (rs) { skip(S, rs); skipRest(rs); return; }
        if (gs.missing) { failed = true; skip(S, "blocked", "缺少必要輸入「" + gs.missing.label + "」。"); skipRest("upstream"); return; }
        const max = loopMax(sNode);
        const t0 = now();
        self.emit("node-start", { id: E });
        let value = gs.inputs.init, done = false, iterations = 0;
        for (let i = 0; i < max; i++) {
          if (signal.aborted) throw CANCEL;
          const it = { index: i, max: max };
          self.emit("loop-iteration", { id: E, startId: S, index: i, max: max });
          self.emit("node-start", { id: S, iteration: it });
          const sOut = { value: value, index: i, loop: { startId: S, index: i, max: max } };
          state.set(S, { status: "ok", outputs: sOut });
          self._cache.set(S, { key: null, outputs: sOut });
          self.emit("node-done", { id: S, outputs: sOut, cached: false, ms: 0, iteration: it, attempts: 1 });
          setRes(S, { status: "done", text: SG.previewText(value), outputs: sOut, key: keyOf(S), attempts: 1 });
          await runScope(bodyIds, L, it);
          iterations = i + 1;
          const ge = gather(E, g.slots(E));
          const re = skipReason(ge);
          if (re) { skip(E, re); return; }
          if (ge.missing) { failed = true; skip(E, "blocked", "缺少必要輸入「" + ge.missing.label + "」。"); return; }
          value = ge.inputs.value;
          try {
            done = g.inputSource(E, "done") ? SG.control.truthy(ge.inputs.done) : SG.control.evalCondition(value, eNode.widgets);
          } catch (e) { fail(E, errText(e), { iterations: iterations }); return; }
          if (done) break;
        }
        const outE = { result: value, count: iterations };
        const preview = SG.previewText(value);
        const capped = "已達上限 " + max + " 輪";
        const text = done ? preview : (preview ? preview + "（" + capped + "）" : capped);
        const ms = now() - t0;
        state.set(E, { status: "ok", outputs: outE });
        self.emit("node-done", { id: E, outputs: outE, cached: false, ms: ms, iterations: iterations, attempts: 1 });
        setRes(E, { status: "done", text: text, outputs: outE, key: keyE, ms: ms, attempts: 1, iterations: iterations, maxed: !done });
        const region = {};
        regionIds.forEach(function (id) {
          const st = state.get(id), r = resMap.get(id);
          if (st && r) region[id] = { state: st, result: Object.assign({}, r) };
        });
        self._cache.set(E, { key: iter ? null : keyE, outputs: outE, region: region });
        await pause(self.stepMs);
      };

      // -------------------------------------------------------- scopes
      const condense = function (ids, loops) {
        const unitOf = new Map();
        loops.forEach(function (L) { L.region.forEach(function (id) { unitOf.set(id, L); }); });
        const units = [], byKey = new Map();
        ids.forEach(function (id, i) {
          const L = unitOf.get(id);
          const k = L || id;
          if (!byKey.has(k)) { const u = { loop: L || null, id: L ? null : id, pos: i, deps: new Set(), outs: [] }; byKey.set(k, u); units.push(u); }
        });
        const idSet = new Set(ids);
        ids.forEach(function (id) {
          const ub = byKey.get(unitOf.get(id) || id);
          g.slots(id).inputs.forEach(function (s) {
            const src = g.inputSource(id, s.name);
            if (!src || !idSet.has(src.node)) return;
            const ua = byKey.get(unitOf.get(src.node) || src.node);
            if (ua && ua !== ub && !ub.deps.has(ua)) { ub.deps.add(ua); ua.outs.push(ub); }
          });
        });
        const indeg = new Map(units.map(function (u) { return [u, u.deps.size]; }));
        let ready = units.filter(function (u) { return indeg.get(u) === 0; });
        const out = [];
        while (ready.length) {
          ready.sort(function (a, b) { return a.pos - b.pos; });
          const u = ready.shift();
          out.push(u);
          u.outs.forEach(function (v) { indeg.set(v, indeg.get(v) - 1); if (indeg.get(v) === 0) ready.push(v); });
        }
        units.forEach(function (u) { if (out.indexOf(u) < 0) out.push(u); });
        return out;
      };
      const runScope = async function (ids, parentLoop, iter) {
        const children = active.filter(function (L) { return parentOf.get(L) === parentLoop; });
        const steps = condense(ids, children);
        for (let i = 0; i < steps.length; i++) {
          if (signal.aborted) throw CANCEL;
          if (steps[i].loop) await runLoop(steps[i].loop, iter);
          else await runNode(steps[i].id, iter);
        }
      };

      let cancelled = false;
      try { await runScope(order, null, null); }
      catch (e) {
        if (e === CANCEL) cancelled = true;
        else throw e;
      }
      if (signal.aborted) cancelled = true;
      const results = order.map(function (id) {
        const r = resMap.get(id);
        if (r) return r;
        return cancelled
          ? { id: id, status: "skipped", reason: "cancelled", text: SKIP_TEXT.cancelled, outputs: undefined, key: null, ms: 0, attempts: 0 }
          : { id: id, status: "skipped", text: "", outputs: undefined, key: keyOf(id), ms: 0, attempts: 0 };
      });
      const r = {
        runId: runId,
        status: cancelled ? "cancelled" : failed ? "error" : "ok",
        order: order.slice(), snapshot: snapshot, results: results
      };
      this.emit("run-end", r);
      return r;
    }
  }

  SG.Executor = Executor;
  SG.raceAbort = raceAbort;
})(globalThis);
