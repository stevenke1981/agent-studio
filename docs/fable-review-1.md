# Fable 5.2 review #1 — after merging workstreams A/B/C (2026-11-26)

Status legend: ✅ fixed in this round · ⏳ open

## Verdict
The implementation follows the frozen contract and Amendments 1–2 faithfully, and the engine is the strongest part:
- loops are condensed into units over a DAG;
- cache keys are per node;
- abort is raced everywhere.

Deviations are additive (`stepMs`/`depth` executor options, `ctx.attempt/iteration/inactive/graph`, `g.load(json,{history})`). The one that matters is `ctx.graph`, which exposes the live mutable graph to node code and would block a worker or remote backend.

The weak spot was the "Subgraph = Agent" path in `comfy/nodes.js`. Persistence and executor lifetime are fine for a demo, but not for real, costly execution.

## Risks / bugs (ranked)
1. ✅ **Sub-agent depth guard never fired.**
   - `ctx.depth` was always 0, so an agent that references itself recursed without limit and froze the tab. The 重用 Agent chooser defaults to the current agent, so this was the default click path.
   - Fix: pass `depth` to the nested executor, carry an ancestor chain, and report a static `subflowIssues` error 「子流程循環引用」. Tested.
2. ✅ **An approval gate inside a sub-agent hung the run.**
   - Fix: a nested `node-wait` now goes through the parent's `ctx.requestApproval`, and the answer is passed back to the nested executor. Tested.
3. ✅ **Permission checks covered only the top-level graph.**
   - Fix: `subflowIssues` walks reachable agent workflows and reports issues on the top-level agent node. Tested.
4. ⏳ **Run history can exhaust localStorage, and a quota failure flips the global storage flag** (`runs.js:33`, `app.js:40,623`).
   - Plan: store each snapshot once, keyed by its content hash; on a quota error, evict the oldest and retry; keep history failures from touching the global flag.
5. ⏳ **Runs execute against the live, editable graph rather than the snapshot** (`executor.js:249,367,402`).
   - Plan: run on a `new Graph(snapshot)` clone, or lock edits while running.
6. ⏳ **The executor cache is discarded on every `App.open`** (`app.js:101`), so every node runs again after switching agents or reloading.
7. ⏳ **Replay paints old statuses onto current nodes that happen to share the same ids** (`app.js:684`).
   - Plan: replay only when the snapshot hash matches, or replay in a read-only canvas.
8. ⏳ **`ctx.graph` leaks into node code** (`executor.js:407`, `core-nodes.js:125`).
   - Plan: replace it with a serialisable `ctx.linked`.

## Next improvements (value / effort)
1. [medium] **Runner seam for real execution.**
   - Add `new Executor(g,{services:{runner}})`. Domain nodes call `ctx.services.runner.run({...})`.
   - The default `SimRunner` keeps both test suites byte-identical.
   - The real runner lives outside `comfy/` (opt-in `bridge/http-runner.js` talking to 127.0.0.1), so the no-fetch grep and the `file://` double-click keep working.
   - Add `runner.id` and the model to the cache key. Test with a record/replay runner.
2. [medium] **IndexedDB storage** for run history plus a content-addressed output cache. Fixes risks 4 and 6.
3. [quick] **Run isolation** on the snapshot clone, with a banner: 「執行中，編輯將套用於下次執行」.
4. [medium] **Write-safety policy.**
   - Nodes with `estimate().writes`, or tool nodes with a write operation, get an implicit approval gate that shows the command or diff.
   - This is a precondition for a real backend.
5. [medium] **ComfyUI UX gaps.**
   - Run to here / run the selected group (`targets` is already supported).
   - Full-output viewer.
   - Queue panel with per-run cancel.
   - Enter a sub-agent node and see its states (breadcrumb, read-only canvas).
   - Save a selection as a template.
6. [medium] **Agent observability.**
   - Actual tokens, ms and cost per node next to the estimate.
   - A budget cap that aborts the run.
   - A `ctx.log` drawer.
   - "Pin output" to freeze a node's result while iterating downstream.
7. [large] **Parallel branches** (concurrency limit) and resumable runs: an approval wait survives a reload.

## Suggested one-week scope
1. ✅ Sub-agent hardening: depth and cycle guard, approval bridging, recursive permission check, tests. ⏳ `file://` smoke check.
2. Runner seam: `SimRunner` as default, `ctx.linked` in place of `ctx.graph`, record/replay test runner. No network yet.
3. Run isolation on the snapshot, plus quota-safe history.
4. Run-to-here / run-selected, and a full-output and log drawer.
5. Stretch: implicit approval for write nodes.
