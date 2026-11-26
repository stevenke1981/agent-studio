/* SeaGraph core nodes: primitives, reroute, note, preview, approval.
 * DOM-free classic script (also loads in Node). Load after comfy/graph.js.
 */
(function (root) {
  "use strict";
  const SG = root.SeaGraph = root.SeaGraph || {};
  if (!SG.registry) throw new Error("SeaGraph: load comfy/graph.js before comfy/core-nodes.js");
  const R = SG.registry;
  const CAT = "基本";

  R.register({
    type: "core/reroute", title: "轉接點", category: CAT,
    hint: "整理連線用的轉接點；類型跟隨上游，不會執行。",
    virtual: true, width: 40,
    inputs: [{ name: "in", type: "*", label: "輸入" }],
    outputs: [{ name: "out", type: "*", label: "輸出" }]
  });

  R.register({
    type: "core/note", title: "備註", category: CAT,
    hint: "在畫布上寫說明文字，不會執行。",
    virtual: true,
    widgets: [{ name: "text", kind: "textarea", label: "內容", default: "", convertible: false }]
  });

  R.register({
    type: "core/primitive-string", title: "文字常數", category: CAT,
    hint: "輸出一段固定文字，可接到已轉為輸入的欄位。",
    outputs: [{ name: "value", type: "STRING", label: "文字" }],
    widgets: [{ name: "value", kind: "text", label: "文字", default: "", convertible: false }],
    estimate: function () { return { tokens: 0, ms: 1, writes: false }; },
    execute: async function (inputs, ctx) {
      const v = ctx.widgets.value;
      return { value: v == null ? "" : String(v) };
    }
  });

  R.register({
    type: "core/primitive-number", title: "數字常數", category: CAT,
    hint: "輸出一個固定數字。",
    outputs: [{ name: "value", type: "NUMBER", label: "數字" }],
    widgets: [{ name: "value", kind: "number", label: "數字", default: 0, convertible: false }],
    estimate: function () { return { tokens: 0, ms: 1, writes: false }; },
    execute: async function (inputs, ctx) {
      const n = Number(ctx.widgets.value);
      return { value: Number.isFinite(n) ? n : 0 };
    }
  });

  R.register({
    type: "core/primitive-boolean", title: "布林常數", category: CAT,
    hint: "輸出是或否。",
    outputs: [{ name: "value", type: "BOOLEAN", label: "布林" }],
    widgets: [{ name: "value", kind: "toggle", label: "啟用", default: false, convertible: false }],
    estimate: function () { return { tokens: 0, ms: 1, writes: false }; },
    execute: async function (inputs, ctx) { return { value: !!ctx.widgets.value }; }
  });

  R.register({
    type: "core/preview", title: "預覽", category: CAT,
    hint: "顯示上游輸出的內容，並原樣傳下去。",
    output: true,
    inputs: [{ name: "value", type: "*", label: "值" }],
    outputs: [{ name: "value", type: "*", label: "值" }, { name: "text", type: "STRING", label: "文字" }],
    typeFrom: "value",
    estimate: function () { return { tokens: 0, ms: 5, writes: false }; },
    execute: async function (inputs) {
      return { value: inputs.value, text: SG.previewText(inputs.value) };
    }
  });

  R.register({
    type: "core/approval", title: "人工核准", category: CAT,
    hint: "暫停執行，等人核准後才把值傳下去；拒絕則下游略過。",
    nocache: true,
    typeFrom: "value",
    inputs: [{ name: "value", type: "*", label: "值" }],
    outputs: [{ name: "value", type: "*", label: "值" }],
    widgets: [
      { name: "message", kind: "textarea", label: "提示訊息", default: "請確認是否繼續" },
      { name: "auto", kind: "toggle", label: "自動核准", default: false, convertible: false }
    ],
    estimate: function () { return { tokens: 0, ms: 0, writes: false }; },
    execute: async function (inputs, ctx) {
      if (ctx.widgets.auto) return { value: inputs.value };
      const ok = await ctx.requestApproval({
        message: ctx.widgets.message == null ? "請確認是否繼續" : String(ctx.widgets.message),
        details: { preview: SG.previewText(inputs.value) }
      });
      if (!ok) {
        const err = new Error("已拒絕" + (ctx.approvalNote ? "：" + ctx.approvalNote : ""));
        err.retryable = false;
        throw err;
      }
      return { value: inputs.value };
    }
  });

  // ------------------------------------------------------- control flow
  const C = SG.control;
  const FLOW = "流程控制";
  const condOpts = function (w) { return { mode: w.mode, pattern: w.pattern, negate: !!w.negate }; };

  R.register({
    type: "core/condition", title: "條件判斷", category: FLOW,
    hint: "依規則判斷輸入（非空、包含文字、等於、符合規則、為真），輸出是或否。",
    inputs: [{ name: "value", type: "*", label: "值" }],
    outputs: [{ name: "result", type: "BOOLEAN", label: "結果" }],
    widgets: C.conditionWidgets("nonempty"),
    estimate: function () { return { tokens: 0, ms: 1, writes: false }; },
    execute: async function (inputs, ctx) {
      return { result: C.evalCondition(inputs.value, condOpts(ctx.widgets)) };
    }
  });

  R.register({
    type: "core/branch", title: "分支", category: FLOW,
    hint: "條件成立走「是」，否則走「否」；未選中的一側下游會略過。",
    typeFrom: "value",
    inputs: [{ name: "value", type: "*", label: "值" }, { name: "condition", type: "BOOLEAN", label: "條件", optional: true }],
    outputs: [{ name: "true", type: "*", label: "是" }, { name: "false", type: "*", label: "否" }],
    widgets: C.conditionWidgets("nonempty"),
    estimate: function () { return { tokens: 0, ms: 1, writes: false }; },
    execute: async function (inputs, ctx) {
      const linked = ctx.graph && ctx.graph.inputSource(ctx.node.id, "condition");
      const ok = linked ? C.truthy(inputs.condition) : C.evalCondition(inputs.value, condOpts(ctx.widgets));
      return ok ? { true: inputs.value, false: SG.INACTIVE } : { true: SG.INACTIVE, false: inputs.value };
    }
  });

  R.register({
    type: "core/merge", title: "合併", category: FLOW,
    hint: "輸出第一個有效的輸入，用來把分支接回同一條路。",
    typeFrom: ["a", "b", "c"],
    inputs: [
      { name: "a", type: "*", label: "A", optional: true },
      { name: "b", type: "*", label: "B", optional: true },
      { name: "c", type: "*", label: "C", optional: true }
    ],
    outputs: [{ name: "value", type: "*", label: "值" }],
    estimate: function () { return { tokens: 0, ms: 1, writes: false }; },
    execute: async function (inputs, ctx) {
      const names = ["a", "b", "c"];
      for (let i = 0; i < names.length; i++) {
        const v = inputs[names[i]];
        if (v !== undefined && !SG.isInactive(v)) return { value: v };
      }
      return { value: ctx.inactive && ctx.inactive.length ? SG.INACTIVE : undefined };
    }
  });

  R.register({
    type: "core/loop-start", title: "迴圈開始", category: FLOW,
    hint: "重複執行到「迴圈結束」之間的節點；第 2 輪起把上一輪結果接回來。",
    loopStart: true,
    typeFrom: "init",
    inputs: [{ name: "init", type: "*", label: "初始值" }],
    outputs: [{ name: "value", type: "*", label: "值" }, { name: "index", type: "NUMBER", label: "輪次" }, { name: "loop", type: "LOOP", label: "迴圈" }],
    widgets: [{ name: "max", kind: "number", label: "最多輪數", default: 3, min: 1, max: C.MAX_LOOP, step: 1, convertible: false }],
    estimate: function () { return { tokens: 0, ms: 0, writes: false }; },
    // Only used when the loop does not iterate (unpaired, muted/bypassed end): a single pass.
    execute: async function (inputs, ctx) {
      return { value: inputs.init, index: 0, loop: { startId: ctx.node.id, index: 0, max: 1 } };
    }
  });

  R.register({
    type: "core/loop-end", title: "迴圈結束", category: FLOW,
    hint: "「完成」為真或達到上限時結束迴圈；未接「完成」時用下方條件判斷值。",
    loopEnd: true,
    typeFrom: "value",
    inputs: [
      { name: "loop", type: "LOOP", label: "迴圈" },
      { name: "value", type: "*", label: "值" },
      { name: "done", type: "BOOLEAN", label: "完成", optional: true }
    ],
    outputs: [{ name: "result", type: "*", label: "結果" }, { name: "count", type: "NUMBER", label: "輪數" }],
    widgets: C.conditionWidgets("truthy"),
    estimate: function () { return { tokens: 0, ms: 0, writes: false }; },
    // Only used when the loop does not iterate: a single pass.
    execute: async function (inputs) { return { result: inputs.value, count: 1 }; }
  });

  SG.coreTypes = [
    "core/reroute", "core/note", "core/primitive-string", "core/primitive-number", "core/primitive-boolean",
    "core/preview", "core/approval", "core/condition", "core/branch", "core/merge", "core/loop-start", "core/loop-end"
  ];
})(globalThis);
