# 小海 Agent 工作室（Agent Studio）

在瀏覽器裡組裝、設定與執行 Agent 工作流程的單機工具。v0.6 起以 **SeaGraph** 取代原本的單進單出流程畫布，改為 ComfyUI 風格的節點圖：多槽位型別連線、快取式執行、核准關卡、分支／重試／迴圈與執行紀錄比對。

- 不需建置、不需安裝、不連網：直接雙擊 HTML 即可（`file://`）。
- 執行為離線模擬且具確定性（同樣的圖、同樣的輸入 → 位元組相同的結果），但介面為 async + `AbortSignal`，日後可接上真實後端。
- 介面文字為正體中文（zh-Hant-TW），保留鍵盤操作與無障礙標籤。

## 快速開始

1. 用瀏覽器開啟 `Agent-Studio-v0.5.html`。
2. 在首頁選擇一個 Agent →「設定」進入流程編輯器。
3. 從左側節點庫拖曳節點（或在畫布空白處雙擊開啟搜尋），連接輸出與輸入槽位。
4. `Ctrl+Enter` 執行；再次執行時未變更的節點會顯示「快取」。

舊版（v0.5）儲存的流程會在開啟時自動遷移；原資料只讀不寫。

## 主要功能

| 類別 | 內容 |
| --- | --- |
| 圖模型 | 多槽位、型別相容檢查（含不可連線原因）、拒絕循環、`validate()`、widget 轉輸入、群組、復原／重做（上限 100）、複製貼上、JSON 匯出入 |
| 執行器 | 拓撲排序、僅重跑變更節點與下游、bypass／mute、reroute、取消、試算（tokens／時間／是否寫入） |
| 控制流程 | 條件、分支、合併、迴圈（巢狀 ≤ 3 層）、每節點重試策略 |
| 人工核准 | `core/approval` 節點；畫布與執行面板皆可核准／拒絕並附註 |
| Agent 即節點 | `agent/<id>`、`skill/<id>`、`tool/<id>` 依實際目錄註冊；Agent 節點以巢狀執行器跑該 Agent 的流程（有界遞迴） |
| 權限感知 | 工具節點顯示讀／寫標記；寫入操作連到只有讀權限的 Agent 時報錯 |
| 執行紀錄 | 每個 Agent 保留最新 20 筆；任選兩筆比對差異、逐步重播、還原該版本 |
| 畫布 | 平移縮放、框選、小地圖、搜尋彈窗、點擊式連線（鍵盤可用）、節點狀態環與進度、行內預覽 |

### 常用快捷鍵

| 按鍵 | 動作 |
| --- | --- |
| `Ctrl+Enter` | 執行 |
| `Delete` | 刪除選取 |
| `Ctrl+C` / `Ctrl+V` | 複製／貼上 |
| `Ctrl+Z` / `Ctrl+Y` | 復原／重做 |
| `Ctrl+A` | 全選 |
| `Ctrl+B` / `Ctrl+M` | bypass／mute |
| `Ctrl+G` | 建立群組 |
| 空白鍵拖曳、方向鍵、滾輪、`+` / `-` | 平移與縮放 |
| `Esc` | 取消連線中的操作 |

## 專案結構

```
Agent-Studio-v0.5.html   主程式（首頁、組裝頁、流程編輯器）
comfy/
  graph.js               型別、節點註冊表、Graph 模型、驗證、歷史、序列化
  executor.js            佇列、快取、事件、取消、核准、控制流程
  core-nodes.js          core/* 基本節點（primitive、reroute、note、preview、approval、condition、branch、loop…）
  nodes.js               領域節點（search/*、code/*、agent/skill/tool 目錄同步）
  migrate.js             v0.5 → workflow JSON 遷移
  runs.js                執行紀錄與差異比對
  canvas.js / canvas.css SeaGraph DOM 畫布（節點為 DOM、連線為 SVG）
  minimap.js, search.js  小地圖、節點搜尋
  app.js / app.css       與主程式整合（節點庫、檢視器、執行面板、紀錄抽屜）
  dev/canvas-demo.html   以 mock 引擎獨立測試畫布
docs/
  comfy-plan.md          凍結的介面契約與增修（Amendment 1、2）
  fable-review-1.md      審查紀錄
tests/
  engine.test.js         引擎測試
  nodes.test.js          領域節點、遷移、執行紀錄測試
```

腳本載入順序：`graph → executor → core-nodes → nodes → migrate → runs → canvas → minimap → search`，接著是 HTML 內嵌腳本，最後才載入 `app.js`。

## 開發

需求：Node.js（只用來跑測試，程式本身不依賴 Node）。

```sh
node tests/engine.test.js
node tests/nodes.test.js
```

約定：

- `comfy/*.js` 一律是 IIFE：`(function(root){ const SG = root.SeaGraph = root.SeaGraph || {}; … })(globalThis);`，檔案最上層不得出現 `const`／`let`／`class`／`import`／`export`（會與 HTML 內嵌腳本的全域名稱衝突）。
- 不得使用 `fetch`、`XMLHttpRequest`、CDN 或任何外部依賴。
- 執行輸出不得使用 `Math.random` 或 `Date`，以維持確定性。
- 介面契約以 `docs/comfy-plan.md` 為準；變更契約須先更新該文件。

快速檢查：

```sh
grep -nE "^(const|let|class|import|export) " comfy/*.js     # 應無輸出
grep -rnE "fetch\(|XMLHttpRequest" comfy/*.js              # 應無輸出
```

## 資料儲存

皆存於瀏覽器 `localStorage`：

- `sea-agent-studio-v06.flow.<agentId>`：流程（workflow JSON）
- `sea-agent-studio-v06.runs.<agentId>`：執行紀錄（最新 20 筆）
- `sea-agent-studio-v02.<agentId>`：舊版資料，只在遷移時讀取，不再寫入

Workflow JSON 格式（`schema: "sea-agent-studio/workflow"`, `version: 1`）詳見 `docs/comfy-plan.md`。
