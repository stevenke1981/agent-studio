/* 小海 Agent 工作室 — run history records and diffs (DOM-free, pure). */
(function (root) {
  "use strict";
  const SG = root.SeaGraph = root.SeaGraph || {};
  const R = SG.runs = SG.runs || {};
  R.cap = 20;

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function firstOutput(outputs) {
    if (!outputs || typeof outputs !== "object") return null;
    for (const k of Object.keys(outputs)) { const v = outputs[k]; if (v && typeof v === "object") return v; }
    return null;
  }

  /** RunResult -> compact storable history entry. */
  R.record = function record(run, meta) {
    run = run || {};
    meta = meta || {};
    const results = (run.results || []).map(r => {
      const out = firstOutput(r.outputs);
      const item = { id: r.id, status: r.status, text: r.text != null ? String(r.text) : (out && out.text) || "" };
      if (r.ms != null) item.ms = r.ms;
      if (r.key != null) item.key = r.key;
      if (out && Array.isArray(out.sources) && out.sources.length) item.sources = out.sources.map(s => ({ title: s.title, url: s.url }));
      return item;
    });
    const at = meta.at || null;
    return {
      id: "run-" + (at || "") + "-" + (run.runId != null ? run.runId : results.length),
      agent: meta.agent != null ? meta.agent : (run.snapshot && run.snapshot.agent) || null,
      at,
      status: run.status || "ok",
      snapshot: clone(run.snapshot) || null,
      order: Array.isArray(run.order) ? run.order.slice() : results.map(r => r.id),
      results
    };
  };

  /** Prepend an entry to a history list, newest first, capped. */
  R.push = function push(list, entry, cap) {
    const next = [entry].concat(Array.isArray(list) ? list.filter(e => e && e.id !== entry.id) : []);
    return next.slice(0, cap || R.cap);
  };

  /** Count statuses of an entry: {done, cached, error, skipped, total}. */
  R.counts = function counts(entry) {
    const c = { done: 0, cached: 0, error: 0, skipped: 0, waiting: 0, total: 0 };
    for (const r of (entry && entry.results) || []) { c.total++; if (c[r.status] !== undefined) c[r.status]++; }
    return c;
  };

  function titleOf(node) {
    if (!node) return "";
    if (node.title) return node.title;
    try { const def = SG.registry && SG.registry.get(node.type); if (def && def.title) return def.title; } catch (e) { /* ignore */ }
    return node.type || node.id;
  }
  function same(a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); }

  /** Compare two history entries (a = before, b = after). */
  R.diff = function diff(a, b) {
    const nodesA = new Map((((a && a.snapshot) || {}).nodes || []).map(n => [n.id, n]));
    const nodesB = new Map((((b && b.snapshot) || {}).nodes || []).map(n => [n.id, n]));
    const resA = new Map(((a && a.results) || []).map(r => [r.id, r]));
    const resB = new Map(((b && b.results) || []).map(r => [r.id, r]));
    const ids = [];
    const addId = id => { if (id != null && ids.indexOf(id) < 0) ids.push(id); };
    ((b && b.order) || []).forEach(addId); nodesB.forEach((_, id) => addId(id)); resB.forEach((_, id) => addId(id));
    ((a && a.order) || []).forEach(addId); nodesA.forEach((_, id) => addId(id)); resA.forEach((_, id) => addId(id));
    return ids.map(id => {
      const na = nodesA.get(id), nb = nodesB.get(id), ra = resA.get(id), rb = resB.get(id);
      const inA = Boolean(na || ra), inB = Boolean(nb || rb);
      const wa = (na && na.widgets) || {}, wb = (nb && nb.widgets) || {};
      const names = Object.keys(wa).concat(Object.keys(wb).filter(k => !(k in wa)));
      const widgetsChanged = inA && inB ? names.filter(k => !same(wa[k], wb[k])) : [];
      const statusBefore = ra ? ra.status : null, statusAfter = rb ? rb.status : null;
      const textBefore = ra ? ra.text : null, textAfter = rb ? rb.text : null;
      let change;
      if (!inA) change = "added";
      else if (!inB) change = "removed";
      else if (widgetsChanged.length || (na && nb && (na.type !== nb.type || (na.mode || "normal") !== (nb.mode || "normal"))) ||
        statusBefore !== statusAfter || textBefore !== textAfter) change = "changed";
      else change = "same";
      return { id, title: titleOf(nb || na) || id, change, statusBefore, statusAfter, textBefore, textAfter, widgetsChanged };
    });
  };
})(globalThis);
