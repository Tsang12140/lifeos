# 日历小结：设置入口 + 编辑模式（执行方案）

> 来源：蛋妞 2026-09-21 11:10 的原话要求。**方案先落纸，等点头再动手**；
> 本文只写「要做什么、怎么分步、怎么验收、哪里还没定」，不写代码。
> 本轮**已经落地**的三件事见「〇」，其余都还没做。

## 〇 本轮已经落地的（不是方案，是既成事实）

1. **AI key 接线修好了**：`apps/api/src/summary.ts` 的 `createDaySummaryProvider` 现在读
   **和助手同一份运行时 AI 配置**（设置页存进 `data/ai-config.json` 的那把 key），
   不再是只认 `LIFEOS_DEEPSEEK_API_KEY` 环境变量；provider 改成**每次请求现取**，
   所以设置页存完 key 不用重启 API。`apps/api/src/server.ts` 的 `/api/summaries` 相应调整。
2. **`manual` 成为一等状态**：`packages/core` 的 `DaySummaryStatus` 加了 `"manual"`；
   月格 tooltip 现在区分 `AI · provider` / `手写` / `规则生成`。
3. **56 天小结已手工重写**（demo）：写进 `day_summaries`，`status/provider = manual`，
   指纹按服务端口径算，端到端验过（真 API 起在副本上问出来的就是手写文本）。
   工具：`.review/write-manual-summaries.mjs`（`--apply` 才写、写前整库备份、`--revert` 是出口）；
   验收：`.review/verify-manual-summaries.mjs`。**这是唯一一次直接写库** —— 后面全走 API。

## 一 目标（蛋妞原话拆解）

| # | 要什么 | 落到哪里 |
|---|---|---|
| 1 | 周期按钮**旁边加个小齿轮** = 日历自己的设置入口 | 日历头（`.calendar-module-button` 同一行） |
| 2 | 齿轮面板里放 **AI 小结** 设置 | 复用 AI 配置那套（key/model/baseUrl/开关） |
| 3 | 面板里**公开给 AI 的提示词**，方便她自己调 | `ai-config.json` 加 `summaryPrompt`，面板给 textarea |
| 4 | **编辑模式**：还是月历/周历那个画面，但文字变成可改的 | 月格/周卡的小结位换成可编辑控件 |
| 5 | **点保存才生效** | 底部一条「N 处改动 · 保存 / 放弃」 |
| 6 | 编辑模式下**右键某天** → 「重新生成小结」 | 自绘小菜单（编辑模式下才出） |
| 7 | **时间轴也可以复原它** | ❓含义未定，见「三 开放问题 1」 |

## 二 分步实施（每步都能单独验收、单独回滚）

### Step 1 数据层（api + core）
- `POST /api/summaries/manual`：body `{entries:[{date,text}]}` → 写 `day_summaries`，
  `status/provider = manual`，指纹按当前输入算；空字符串 = 撤销该天的手写（回落自动）。
- `POST /api/summaries/regenerate`：body `{date}`（或 `{from,to}`）→ 用当前 provider
  **强制重算**那一天（有 key 走 AI，没有就走规则）。
- `PUT /api/ai/config` 增加 `summaryPrompt` 字段（读/写/公开三处一起改）；
  provider 构造函数已经留好这个参数（上一轮埋的）。
- **★ 必须同时修缓存失效条件**：现在 `resolveDaySummaries` 只比对「输入指纹」，
  **不认「算法/模型/提示词变没变」** —— 这就是历史上一批 5 字碎片永久留着的原因。
  修法：把 provider 身份（kind/providerId/model + 提示词哈希）并入缓存键或比对条件。

### Step 2 齿轮 + 设置面板（前端）
- 日历头加齿轮按钮 → 打开 `#calendar-settings-panel`（沿用 `.cycle-inline-panel` 的内联面板语言）。
- 面板分两块：**AI 小结**（开关 / key / 模型 / baseUrl / **提示词 textarea** / 测试连接 / 保存）
  与 **编辑模式**（开关）。

### Step 3 编辑模式（前端）
- 状态：`editMode: boolean` + `drafts: Map<date, string>`（只装改动过的天）。
- 月格小结位与周卡文字位渲染成可编辑控件，**视觉尺寸尽量不变**（否则会跳版）。
- 底部保存条：`N 处改动 · 保存 / 放弃`。保存 → 只发改动过的；失败 → 不清 drafts。
- 退出编辑模式且有未保存改动 → 二次确认。

### Step 4 右键菜单（前端）
- 编辑模式下 `onContextMenu` 拦掉浏览器默认菜单，弹一个定位小菜单：
  **重新生成小结** / **恢复原样**（撤销手写）/ 取消。
- 「重新生成」→ `POST /api/summaries/regenerate {date}`，回来后只替换那一天。

## 三 开放问题（要蛋妞拍板）

1. **「时间轴也可以复原它」到底指哪个**：
   (a) 编辑模式在**时间轴视图**里同样能改小结？
   (b) 手写之后能**一键复原**成自动摘要（月历/时间轴都有入口）？
   (c) 时间轴上的**记录正文**也想编辑？（那就不是小结的事了）
2. **手写的存亡规则**：记录一改，现在会自动重算 → 手写会被覆盖吗？
   我倾向：**手写优先，记录怎么变都保住，直到她手动「恢复原样」**。
3. **提示词粒度**：一个全局的（所有天共用）我理解是你要的；要不要再区分「有记录的组 / 只有笔记的组」？
4. **只有笔记（note）的日子永远没有小结**（服务端 `/api/summaries` 明确跳过 note —— 例如 8/17
   那天只有一条笔记，我写了手工小结它也不返回）。要不要把笔记纳入摘要输入？
5. 那 2 条验收残留（`2036-09-15`、`2099-01-01`）要不要顺手清掉。

## 四 验收方式（沿用本仓既有铁律）

- 新脚本 `.review/verify-summary-editing.mjs`：**自带隔离实例**（独占端口 + 独立 `LIFEOS_DATA_DIR`），
  断言：① 保存前页面不生效；② 保存后 API 回 `manual` 且文本一致；③ 复原后回落到规则/AI；
  ④ 改提示词后强制重算真的换文本；⑤ 右键「重新生成」只动那一天。
- 回归：core / api 测试全绿、web `tsc --noEmit` 零错、既有 `verify-*.mjs` 不许变红。
- 视觉全是 CDP 断言（尺寸/颜色/元素计数），**不出截图**。

## 五 风险

- 写库一律走 API；直接开库的工具（本轮那个）带整库备份 + `--revert`，且只在 demo 用一次。
- 编辑模式改的是「派生数据」，原则上不该碰 `records` —— 手写小结只落 `day_summaries`。
- 齿轮面板要能关掉 AI 小结（无 key 时整块应显示成「未配置」而不是假装能用）。
