/* SeaGraph minimap — workstream B.
 * SG.Minimap.mount(canvasApi, hostEl?) -> {el, redraw(), setVisible(bool), destroy()}
 * Uses the canvas API extras: getView, setView, viewportSize, nodeRects, groupRects, on.
 * Mouse affordance only (keyboard users pan with arrow keys), so it is aria-hidden and not focusable.
 */
(function (root) {
  const SG = root.SeaGraph = root.SeaGraph || {};

  const STATUS_COLOR = {
    queued: "#d9a441", running: "#5aa7ff", waiting: "#f0b429", done: "#4caf7d",
    cached: "#4aa3a0", error: "#e5534b", skipped: "#6b7480"
  };

  function mount(api, host) {
    host = host || api.root;
    const doc = host.ownerDocument || root.document;
    const win = doc.defaultView || root;
    const raf = win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : function (f) { return setTimeout(f, 16); };
    const W = 200, H = 140;
    const el = doc.createElement("canvas");
    el.className = "sg-minimap";
    el.setAttribute("aria-hidden", "true");
    el.title = "小地圖：點擊或拖曳以移動畫面";
    const dpr = Math.max(1, Math.min(3, win.devicePixelRatio || 1));
    el.width = W * dpr;
    el.height = H * dpr;
    host.append(el);
    const ctx = el.getContext ? el.getContext("2d") : null;
    let queued = false;
    let map = null; // {minX, minY, s, ox, oy}
    let dragging = false;
    let visible = true;

    function worldViewRect() {
      const v = api.getView(), vs = api.viewportSize();
      return { x: -v.x / v.k, y: -v.y / v.k, w: vs.w / v.k, h: vs.h / v.k };
    }

    function draw() {
      queued = false;
      if (!ctx || !visible) return;
      const rects = api.nodeRects();
      const groups = api.groupRects ? api.groupRects() : [];
      const vr = worldViewRect();
      let x1 = vr.x, y1 = vr.y, x2 = vr.x + vr.w, y2 = vr.y + vr.h;
      rects.concat(groups).forEach(function (r) {
        x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
        x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
      });
      const pad = 40;
      x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
      const s = Math.min(W / (x2 - x1), H / (y2 - y1));
      const ox = (W - (x2 - x1) * s) / 2, oy = (H - (y2 - y1) * s) / 2;
      map = { minX: x1, minY: y1, s: s, ox: ox, oy: oy };
      const tx = function (x) { return ox + (x - x1) * s; };
      const ty = function (y) { return oy + (y - y1) * s; };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      groups.forEach(function (g) {
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = g.color || "#3b82f6";
        ctx.fillRect(tx(g.x), ty(g.y), g.w * s, g.h * s);
      });
      ctx.globalAlpha = 1;
      rects.forEach(function (r) {
        ctx.fillStyle = r.missing ? "#7a2e2e" : r.mode === "bypass" ? "#6b4c9a" : r.mode === "mute" ? "#3a414a" : "#4a5a6c";
        ctx.fillRect(tx(r.x), ty(r.y), Math.max(2, r.w * s), Math.max(2, r.h * s));
        const c = STATUS_COLOR[r.status];
        if (c) { ctx.fillStyle = c; ctx.fillRect(tx(r.x), ty(r.y), Math.max(2, r.w * s), Math.max(1.5, 3 * s + 1)); }
        if (r.selected) { ctx.strokeStyle = "#a4ccf5"; ctx.lineWidth = 1; ctx.strokeRect(tx(r.x) - 0.5, ty(r.y) - 0.5, r.w * s + 1, r.h * s + 1); }
      });
      ctx.strokeStyle = "#8cb7ea";
      ctx.lineWidth = 1.5;
      ctx.fillStyle = "rgba(140,183,234,0.08)";
      ctx.fillRect(tx(vr.x), ty(vr.y), vr.w * s, vr.h * s);
      ctx.strokeRect(tx(vr.x), ty(vr.y), vr.w * s, vr.h * s);
    }
    function redraw() { if (!queued) { queued = true; raf(draw); } }

    function panTo(e) {
      if (!map) return;
      const r = el.getBoundingClientRect();
      const mx = (e.clientX - r.left) * (W / r.width), my = (e.clientY - r.top) * (H / r.height);
      const wx = map.minX + (mx - map.ox) / map.s, wy = map.minY + (my - map.oy) / map.s;
      const v = api.getView(), vs = api.viewportSize();
      api.setView({ x: vs.w / 2 - wx * v.k, y: vs.h / 2 - wy * v.k, k: v.k });
    }
    function onDown(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      panTo(e);
    }
    function onMove(e) { if (dragging) panTo(e); }
    function onUp() { dragging = false; }
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", function (e) { e.stopPropagation(); }, { passive: true });
    el.addEventListener("dblclick", function (e) { e.stopPropagation(); });

    const offs = ["view", "render", "move", "select", "state"].map(function (evt) { return api.on(evt, redraw); });
    offs.push(api.on("destroy", function () { destroy(); }));
    redraw();

    function destroy() {
      offs.forEach(function (off) { off(); });
      el.remove();
    }
    return {
      el: el,
      redraw: redraw,
      setVisible: function (v) { visible = !!v; el.hidden = !visible; if (visible) redraw(); },
      destroy: destroy
    };
  }

  SG.Minimap = { mount: mount };
})(globalThis);
